/**
 * 宿主 polyfill 补齐：平台代码（尤其是酷狗 infSign vendor）在模块初始化阶段
 * 就会访问 window / navigator / document，因此必须在任何 musicSdk import
 * 之前执行。main.ts 把它放在第一条 import。
 */
const g = globalThis as any

if (!g.window) g.window = g
if (!g.global) g.global = g

if (typeof g.navigator === 'undefined' || !g.navigator) {
  const navigatorStub = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    platform: 'Win32',
    language: 'zh-CN',
  }
  try {
    Object.defineProperty(g, 'navigator', { value: navigatorStub, configurable: true })
  } catch {
    g.navigator = navigatorStub
  }
}

if (!g.document) {
  g.document = {
    createElement() {
      return {
        setAttribute() {},
        appendChild() {},
        parentNode: { removeChild() {} },
        style: {},
      }
    },
    body: { appendChild() {} },
    documentElement: {},
    head: { appendChild() {} },
  }
}

export {}
