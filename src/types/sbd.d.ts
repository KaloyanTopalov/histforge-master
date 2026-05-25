declare module "sbd" {
  const tokenizer: {
    sentences(text: string, options?: Record<string, unknown>): string[];
  };
  export default tokenizer;
}
