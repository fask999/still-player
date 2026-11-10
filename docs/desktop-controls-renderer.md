# 桌面控制设置组件

`src/renderer/desktop-controls.js` 是普通脚本，不自动注册。设置页加载 `desktop-controls.css` 和脚本后，由 bootstrap 在创建 features 后、runtime.start 前注册一次：

```js
const features = registry.get('features')({app, timeline, glass});
extensions.features = features;
const desktopModule = window.STILLDesktopControls.createModule({app});
features.registerSettingsSection('desktop', ctx => desktopModule.render(ctx));
```

`registerSettingsSection` 不返回 disposer，重复 ID 会抛错。插槽提供 `ctx.current()`，其对话框 token 或 DOM 连接失效时，组件停止处理命令和回复；对话框关闭时立即清理订阅和计时器，无关闭事件时在下一次事件、回复或计时器检查时清理。`render` 同步返回新的宿主 DOM；再次调用会替换上次实例。运行时销毁时调用 `desktopModule.dispose()`，移除对话框监听并清理实例；dispose 后不得再次 render。`createModule` 不负责注册，也不依赖 `app.features`。可选传入 `bridge`、`onError`，默认使用 `window.still`，错误本身已在设置区显示。

独立调用场景也可使用原接口：

```js
const controls = window.STILLDesktopControls.create({
  bridge: window.still,
  onError: error => { /* 可选：宿主统一记录或提示 */ }
});
controls.mount(settingsSlot);
// 设置页销毁时：
controls.dispose();
```

`bridge` 可省略，默认使用 `window.still`；`invoke` 返回值或抛错，`on('desktop', callback)` 返回取消订阅函数。`mount` 使用并替换容器内容；再次挂载会移除旧容器中的组件、读取新状态，但不会增加事件订阅或倒计时。`dispose` 移除组件、取消订阅并清理倒计时；之后可以重新挂载。销毁或重新挂载前发出的异步回复不会更新新的宿主。

首次挂载调用 `desktop:status`，后续使用 `desktop` 事件及每次写入后的状态读取；较早发出的读取不会覆盖较新的事件。复选框与快捷键保存通过 `settings:update` 的 `{patch:{desktop:{key:value}}}` 写入，定时停止分别发送 `desktop:sleepTimer:set {minutes}` 和 `desktop:sleepTimer:cancel {}`。设置返回的完整 settings 不作为桌面运行状态。`available:false` 隐藏控制并说明不可用；`readOnly:true` 显示状态但禁用所有写入。单次写入期间控件暂时禁用，错误以文本显示并传给可选的 `onError`。

倒计时根据最近的主线程状态在本地估算，只用于显示；归零后等待主线程报告结果，不自行执行停止。快捷键显式保存，空值清除，输入需要 Ctrl 或 Alt，媒体键不接受；具体键名、保留组合、冲突与注册结果由主线程最终判断。每项注册失败单独显示。

验证：`node --test tests/desktop-controls-renderer.test.js`。这是 DOM fixture 与 CSS 静态检查，不证明真实窗口尺寸、屏幕阅读器、系统媒体卡片、系统电源状态、全局快捷键注册或实际播放/停止行为；这些需要在获准的桌面环境中另行验收。
