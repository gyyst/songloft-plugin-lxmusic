/**
 * 注入到每个音源子 VM 的 lx prelude。
 *
 * 目标是复刻洛雪音乐桌面版 user API 的公开接口：
 * - lx.request(url, options, callback)：回调风格，响应结构对齐 needle
 * - lx.send(eventName, data)：向宿主抛事件
 * - lx.on('request', handler)：注册播放链接解析处理器
 * - lx.utils.{buffer,crypto,zlib}
 * - lx.currentScriptInfo / lx.version / lx.env
 *
 * 额外提供 lx._dispatch(reqId, eventName, dataJSON)，供插件主环境驱动一次
 * request 事件，并通过 dispatchResult / dispatchError 事件回传结果。
 * 内建 18s 看门狗，保证 handler 卡死时 executeWait 也能及时结束。
 *
 * 注意：本字符串在 QuickJS 子 VM 中执行，只能用子 VM 已有的全局能力
 * （fetch / setTimeout / Promise / Buffer / crypto / zlib / __go_* 桥接）。
 */
export const LX_PRELUDE_JS = String.raw`(function () {
  'use strict';
  var g = globalThis;
  if (!g.window) g.window = g;
  if (!g.global) g.global = g;
  if (!g.navigator) {
    try {
      Object.defineProperty(g, 'navigator', {
        value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        configurable: true
      });
    } catch (e) {
      g.navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
    }
  }

  var EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' };
  var requestHandler = null;
  var handlers = {};
  var BufferCtor = g.Buffer;
  var cryptoApi = g.crypto || {};
  var zlibApi = g.zlib || {};
  var DH = '0123456789abcdef';

  function toError(e) {
    if (e instanceof Error) return e;
    if (e && typeof e.message === 'string') return new Error(e.message);
    return new Error(String(e));
  }

  function logError() {
    try {
      if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
        console.error.apply(console, arguments);
      }
    } catch (e) {}
  }

  /** 子 VM 不一定有 atob，优先使用宿主 Buffer 解 base64。 */
  function base64ToBytes(text) {
    var b64 = String(text == null ? '' : text).replace(/\s+/g, '');
    if (BufferCtor && typeof BufferCtor.from === 'function') {
      var buf = BufferCtor.from(b64, 'base64');
      if (buf && typeof buf.length === 'number') {
        var out = new Uint8Array(buf.length);
        for (var i = 0; i < buf.length; i++) out[i] = buf[i] & 255;
        return out;
      }
    }
    if (typeof atob === 'function') {
      var bin = atob(b64);
      var decoded = new Uint8Array(bin.length);
      for (var j = 0; j < bin.length; j++) decoded[j] = bin.charCodeAt(j) & 255;
      return decoded;
    }
    throw new Error('base64 decoder unavailable');
  }

  function isBufferLike(v) {
    return !!v && typeof v === 'object' && typeof v._hex === 'string';
  }

  function bytesToHex(bytes) {
    var h = '';
    for (var i = 0; i < bytes.length; i++) h += DH[(bytes[i] >> 4) & 15] + DH[bytes[i] & 15];
    return h;
  }

  function hexToBytes(hex) {
    hex = String(hex || '');
    if (hex.length % 2) hex = '0' + hex;
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) {
      var hi = DH.indexOf(hex.charAt(i * 2));
      var lo = DH.indexOf(hex.charAt(i * 2 + 1));
      out[i] = ((hi < 0 ? 0 : hi) << 4) | (lo < 0 ? 0 : lo);
    }
    return out;
  }

  /** 把 Buffer-like / 字符串 / TypedArray 统一成 hex 字符串。 */
  function bufferHex(buf) {
    if (buf === undefined || buf === null) return '';
    if (isBufferLike(buf)) return buf._hex;
    if (typeof buf === 'string') return __go_buffer_from(buf, 'utf8');
    if (typeof Uint8Array !== 'undefined' && buf instanceof Uint8Array) return bytesToHex(buf);
    if (typeof ArrayBuffer !== 'undefined' && buf instanceof ArrayBuffer) return bytesToHex(new Uint8Array(buf));
    if (typeof buf.length === 'number') {
      var arr = new Uint8Array(buf.length);
      for (var i = 0; i < buf.length; i++) arr[i] = buf[i] & 255;
      return bytesToHex(arr);
    }
    if (typeof buf === 'number') return __go_buffer_from(String(buf), 'utf8');
    return __go_buffer_from(String(buf), 'utf8');
  }

  function bufferFromHex(hex) {
    // 宿主 Buffer.from 的字符串 + hex 形式有专用桥接，比传 {_hex} 对象更可靠。
    return BufferCtor.from(String(hex || ''), 'hex');
  }

  // ===== lx.utils.buffer =====
  var bufferUtils = {
    from: function (value, enc) {
      // 宿主的 Buffer.from 只保证字符串 + 编码；对象/数组先转 hex 再构造。
      if (value !== null && typeof value === 'object') {
        if (isBufferLike(value)) return bufferFromHex(value._hex);
        if (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array) return bufferFromHex(bytesToHex(value));
        if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return bufferFromHex(bytesToHex(new Uint8Array(value)));
        if (typeof value.length === 'number') {
          var bytes = new Uint8Array(value.length);
          for (var i = 0; i < value.length; i++) bytes[i] = value[i] & 255;
          return bufferFromHex(bytesToHex(bytes));
        }
      }
      return BufferCtor.from(value, enc === undefined ? 'utf8' : enc);
    },
    bufToString: function (buf, format) {
      var fmt = format || 'utf8';
      if (typeof __go_buffer_to_string === 'function') {
        return __go_buffer_to_string(bufferHex(buf), fmt);
      }
      return BufferCtor.from(bufferHex(buf), 'hex').toString(fmt);
    },
    concat: function (list, totalLength) {
      return BufferCtor.concat(list, totalLength);
    },
    isBuffer: function (buf) {
      return !!(BufferCtor.isBuffer && BufferCtor.isBuffer(buf));
    }
  };

  // ===== lx.utils.crypto =====
  function aesEncryptImpl(buffer, mode, key, iv) {
    if (typeof cryptoApi.aesEncrypt === 'function') return cryptoApi.aesEncrypt(buffer, mode, key, iv);
    var m = String(mode || 'cbc').toLowerCase().indexOf('ecb') >= 0 ? 'ecb' : 'cbc';
    return bufferFromHex(__go_crypto_aes_encrypt(bufferHex(buffer), m, bufferHex(key), iv ? bufferHex(iv) : ''));
  }

  function aesDecryptImpl(buffer, mode, key, iv) {
    if (typeof cryptoApi.aesDecrypt === 'function') return cryptoApi.aesDecrypt(buffer, mode, key, iv);
    var m = String(mode || 'cbc').toLowerCase().indexOf('ecb') >= 0 ? 'ecb' : 'cbc';
    return bufferFromHex(__go_crypto_aes_decrypt(bufferHex(buffer), m, bufferHex(key), iv ? bufferHex(iv) : ''));
  }

  /**
   * Node crypto.publicEncrypt({ padding: RSA_NO_PADDING }) 的纯 JS 实现。
   * 洛雪音源常见的握手会先把明文左补零到密钥长度，再做无填充 RSA。
   */
  function rsaNoPadding(buffer, key) {
    var pem = String(key == null ? '' : key)
      .replace(/-----BEGIN [^-]+-----/g, '')
      .replace(/-----END [^-]+-----/g, '')
      .replace(/\s+/g, '');
    var bin = base64ToBytes(pem);
    var der = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) der[i] = bin[i] & 255;

    var pos = 0;
    function readLen() {
      var l = der[pos++];
      if (l & 128) {
        var n = l & 127;
        l = 0;
        while (n-- > 0) l = (l << 8) | der[pos++];
      }
      return l;
    }
    function readTlv() {
      var tag = der[pos++];
      var len = readLen();
      var start = pos;
      pos += len;
      return { tag: tag, start: start, end: start + len };
    }
    function bytesToBigInt(bytes) {
      var v = 0n;
      for (var i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
      return v;
    }
    var outer = readTlv();
    if (outer.tag !== 48) throw new Error('invalid RSA public key');
    pos = outer.start;
    var first = readTlv();
    if (first.tag === 48) {
      // SubjectPublicKeyInfo: AlgorithmIdentifier + BIT STRING(RSAPublicKey)
      pos = first.end;
      var bit = readTlv();
      if (bit.tag !== 3) throw new Error('invalid RSA public key');
      pos = bit.start + 1;
      var seq = readTlv();
      if (seq.tag !== 48) throw new Error('invalid RSA public key');
      pos = seq.start;
    } else if (first.tag === 2) {
      // PKCS#1 RSAPublicKey
      pos = first.start;
    } else {
      throw new Error('invalid RSA public key');
    }
    var nTlv = readTlv();
    var eTlv = readTlv();
    if (nTlv.tag !== 2 || eTlv.tag !== 2) throw new Error('invalid RSA public key');
    var n = bytesToBigInt(der.subarray(nTlv.start, nTlv.end));
    var e = bytesToBigInt(der.subarray(eTlv.start, eTlv.end));
    var keyLen = Math.ceil(n.toString(16).length / 2);
    var data = hexToBytes(bufferHex(buffer));
    if (data.length > keyLen) throw new Error('RSA data too long');
    var padded = new Uint8Array(keyLen);
    padded.set(data, keyLen - data.length);
    var m = bytesToBigInt(padded) % n;
    var c = 1n;
    var base = m;
    var exp = e;
    while (exp > 0n) {
      if ((exp & 1n) === 1n) c = (c * base) % n;
      base = (base * base) % n;
      exp >>= 1n;
    }
    var out = new Uint8Array(keyLen);
    var v = c;
    for (var j = keyLen - 1; j >= 0; j--) {
      out[j] = Number(v & 255n);
      v >>= 8n;
    }
    return bytesToHex(out);
  }

  var cryptoUtils = {
    md5: function (str) {
      if (typeof cryptoApi.md5 === 'function') return cryptoApi.md5(String(str));
      return __go_crypto_md5(String(str));
    },
    randomBytes: function (size) {
      var r = typeof cryptoApi.randomBytes === 'function'
        ? cryptoApi.randomBytes(size)
        : { _hex: __go_crypto_random_bytes(size) };
      return bufferFromHex(bufferHex(r));
    },
    aesEncrypt: aesEncryptImpl,
    aesDecrypt: aesDecryptImpl,
    rsaEncrypt: function (buffer, key) {
      return bufferFromHex(rsaNoPadding(buffer, key));
    }
  };

  // ===== lx.utils.zlib（洛雪 API 是 Promise 风格） =====
  function zlibPromise(fn) {
    return new Promise(function (resolve, reject) {
      try {
        resolve(fn());
      } catch (e) {
        reject(toError(e));
      }
    });
  }

  function zlibInflate(buf) {
    if (typeof zlibApi.inflate === 'function') return zlibApi.inflate(buf);
    return bufferFromHex(__go_zlib_inflate(bufferHex(buf)));
  }
  function zlibDeflate(buf) {
    if (typeof zlibApi.deflate === 'function') return zlibApi.deflate(buf);
    return bufferFromHex(__go_zlib_deflate(bufferHex(buf)));
  }

  var zlibUtils = {
    inflate: function (buf) {
      return zlibPromise(function () { return zlibInflate(buf); });
    },
    deflate: function (buf) {
      return zlibPromise(function () { return zlibDeflate(buf); });
    },
    inflateRaw: function (buf) {
      return zlibPromise(function () { return bufferFromHex(__go_raw_inflate(bufferHex(buf))); });
    }
  };

  function headerValue(headers, name) {
    if (!headers) return undefined;
    var lower = String(name).toLowerCase();
    for (var k in headers) {
      if (String(k).toLowerCase() === lower) return headers[k];
    }
    return undefined;
  }

  function headersToObject(h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function') {
      h.forEach(function (value, key) {
        out[String(key).toLowerCase()] = value;
      });
    } else {
      for (var k in h) out[String(k).toLowerCase()] = h[k];
    }
    try {
      if (typeof h.getSetCookie === 'function') {
        var sc = h.getSetCookie();
        if (sc && sc.length) out['set-cookie'] = sc.length === 1 ? sc[0] : sc.slice();
      }
    } catch (e) {}
    return out;
  }

  /**
   * lx.request(url, options, callback)
   * 回调签名 callback(err, resp, body)，resp 结构对齐 needle：
   * { statusCode, statusMessage, headers, bytes, raw, body }
   */
  var lxRequest = function (url, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    options = options || {};
    var finished = false;
    var timer = null;

    function finish(err, resp, body) {
      if (finished) return;
      finished = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (typeof callback === 'function') {
        try {
          callback(err || null, resp || null, body === undefined ? null : body);
        } catch (e) {
          logError('lx.request callback error:', e && e.stack ? e.stack : e);
        }
      }
    }

    var method = String(options.method || 'GET').toUpperCase();
    var headers = {};
    if (options.headers) {
      for (var hk in options.headers) headers[hk] = options.headers[hk];
    }
    var body = options.body;
    if (options.form) {
      var parts = [];
      for (var fk in options.form) {
        var fv = options.form[fk];
        if (fv === undefined || fv === null) continue;
        parts.push(encodeURIComponent(fk) + '=' + encodeURIComponent(String(fv)));
      }
      body = parts.join('&');
      if (headerValue(headers, 'content-type') === undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (options.formData) {
      var boundary = '----SongloftLXFormBoundary' + Math.random().toString(16).slice(2) + __go_now_ms().toString(16);
      var chunks = [];
      for (var dk in options.formData) {
        var dv = options.formData[dk];
        if (dv && typeof dv === 'object' && 'value' in dv) dv = dv.value;
        if (dv === undefined || dv === null) continue;
        chunks.push('--' + boundary + '\r\nContent-Disposition: form-data; name="' + dk + '"\r\n\r\n' + String(dv) + '\r\n');
      }
      chunks.push('--' + boundary + '--\r\n');
      body = chunks.join('');
      if (headerValue(headers, 'content-type') === undefined) headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary;
    } else if (body && typeof body === 'object') {
      body = JSON.stringify(body);
      if (headerValue(headers, 'content-type') === undefined) headers['Content-Type'] = 'application/json';
    }

    var fetchOptions = { method: method, headers: headers };
    if (body !== undefined && body !== null) fetchOptions.body = body;

    var timeout = Number(options.response_timeout || options.timeout || 60000);
    if (!(timeout > 0)) timeout = 60000;
    if (timeout > 60000) timeout = 60000;
    timer = setTimeout(function () {
      finish(new Error('Request timeout after ' + timeout + 'ms'));
    }, timeout);

    fetch(String(url), fetchOptions).then(function (resp) {
      return resp.arrayBuffer().then(function (arrayBuffer) {
        var raw = BufferCtor.from(bytesToHex(new Uint8Array(arrayBuffer)), 'hex');
        var text = raw.toString('utf8');
        var parsed = text;
        try {
          parsed = JSON.parse(text);
        } catch (e) {}
        finish(null, {
          statusCode: resp.status,
          statusMessage: resp.statusText || '',
          headers: headersToObject(resp.headers),
          bytes: raw.length,
          raw: raw,
          body: parsed
        }, parsed);
      });
    }).catch(function (err) {
      finish(toError(err));
    });

    return function () {
      finished = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  };

  var lx = {
    version: '2.0.0',
    env: 'desktop',
    EVENT_NAMES: EVENT_NAMES,
    currentScriptInfo: {
      name: '',
      description: '',
      version: '',
      author: '',
      homepage: '',
      rawScript: ''
    },
    on: function (eventName, handler) {
      return new Promise(function (resolve, reject) {
        if (typeof handler !== 'function') {
          reject(new Error('handler must be a function'));
          return;
        }
        if (eventName === EVENT_NAMES.request) requestHandler = handler;
        else handlers[eventName] = handler;
        resolve();
      });
    },
    send: function (eventName, data) {
      return new Promise(function (resolve) {
        try {
          __go_send(String(eventName), JSON.stringify(data === undefined ? null : data));
        } catch (e) {
          logError('lx.send error:', e && e.stack ? e.stack : e);
        }
        resolve();
      });
    },
    request: lxRequest,
    utils: {
      buffer: bufferUtils,
      crypto: cryptoUtils,
      zlib: zlibUtils
    },
    /**
     * 由插件主环境调用：触发一次 request 事件。
     * 结果通过 __go_send('dispatchResult' | 'dispatchError', JSON) 回传，
     * payload 形如 { reqId, name, data }。
     */
    _dispatch: function (reqId, eventName, dataJSON) {
      var payload;
      try {
        payload = JSON.parse(dataJSON || '{}');
      } catch (e) {
        payload = {};
      }
      var done = false;
      var watchdog = null;

      function finish(name, data) {
        if (done) return;
        done = true;
        if (watchdog !== null) {
          clearTimeout(watchdog);
          watchdog = null;
        }
        try {
          __go_send(name, JSON.stringify({ reqId: reqId, name: name, data: data }));
        } catch (e) {
          logError('lx._dispatch send error:', e && e.stack ? e.stack : e);
        }
      }

      var handler = eventName === EVENT_NAMES.request ? requestHandler : handlers[eventName];
      if (typeof handler !== 'function') {
        finish('dispatchError', { error: 'handler not found for event: ' + eventName });
        return;
      }

      watchdog = setTimeout(function () {
        finish('dispatchError', { error: 'handler timeout after 18000ms' });
      }, 18000);

      var event = {
        source: payload.source,
        action: payload.action,
        info: payload.info
      };
      var api = {
        send: function (name, data) {
          finish('dispatchResult', data);
        },
        request: lxRequest,
        utils: lx.utils,
        currentScriptInfo: lx.currentScriptInfo,
        version: lx.version,
        env: lx.env,
        EVENT_NAMES: EVENT_NAMES,
        on: lx.on
      };

      var result;
      try {
        result = handler(event, api);
      } catch (e) {
        finish('dispatchError', { error: String(e && e.message ? e.message : e) });
        return;
      }
      Promise.resolve(result).then(function (value) {
        finish('dispatchResult', value);
      }, function (err) {
        finish('dispatchError', { error: String(err && err.message ? err.message : err) });
      });
    }
  };

  g.lx = lx;
})();`
