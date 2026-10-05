// The panel outlives any one browser process. Only an explicit get() launches
// another browser; closing a window never schedules an automatic relaunch.
export class BrowserSession {
  constructor(launch, onDisconnect, onError = () => {}) {
    Object.assign(this, {launch,onDisconnect,onError});
  }
  async get() {
    if (this.stopping) throw new Error('脚本正在停止，不能打开浏览器。');
    if (this.context) return this.context;
    if (!this.pending) {
      this.pending = this.launch().then(async context => {
        if (this.stopping) {
          await context.close();
          throw new Error('脚本正在停止，已关闭新打开的浏览器。');
        }
        this.context = context;
        context.once('close',() => {
          if (this.context !== context) return;
          this.context = null;
          if (!this.stopping) {
            try { Promise.resolve(this.onDisconnect()).catch(this.onError); }
            catch (error) { this.onError(error); }
          }
        });
        return context;
      }).finally(() => { this.pending = null; });
    }
    return this.pending;
  }
  async close() {
    this.stopping = true;
    const context = this.context ?? await this.pending?.catch(() => null);
    await context?.close();
  }
}
