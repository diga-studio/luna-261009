export class DnsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnsError";
  }
}
