function assertPageAccessible(state) {
  const text = state?.bodyText || "";
  if (!state?.url || state.url === "about:blank") {
    throw new Error("Boss 页面变成了 about:blank，已停止，避免继续产生请求");
  }
  if (/安全验证|访问异常|请完成验证|环境存在异常|访问频繁|访问受限|限制访问|账户存在异常行为|captcha/i.test(text)) {
    throw new Error("Boss 页面访问受限，已暂停并保留断点；请在前台人工恢复后再续跑，脚本不会重试或绕过限制");
  }
  if (/扫码登录|手机号登录|登录后查看|登录\/注册/.test(text)) {
    throw new Error("专用 Chrome 的 Boss 登录状态不可用，请先运行 --login-only");
  }
}

export { assertPageAccessible };
