export class Logger {
  constructor(private showLogs: boolean) {}

  log(...args: any[]) {
    if (this.showLogs) {
      console.log(...args);
    }
  }
}
