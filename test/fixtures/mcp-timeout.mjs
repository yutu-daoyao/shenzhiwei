// Test child only: exercise the real adapter deadline without waiting five minutes.
const originalTimeout=globalThis.setTimeout;
globalThis.setTimeout=(callback,milliseconds,...args)=>originalTimeout(callback,milliseconds===300000?1500:milliseconds,...args);
