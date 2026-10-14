// The demo's model is scripted, so the real provider SDKs stay out of the bundle.
const offline = () => { throw new Error("Real model providers are not available in this demo."); };
export default class OpenAI { constructor() { offline(); } }
export class AzureOpenAI { constructor() { offline(); } }
