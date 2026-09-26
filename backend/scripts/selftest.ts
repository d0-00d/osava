// Start llama-server the way OSAVA does (verify model, launch, prove identity,
// run the contract's canaries) and report. Stops the server afterwards.
//
//   npm run selftest
import { installModel, startServer, stopServer } from "../src/services/behaviour/runtime";

(async () => {
  console.log("model:", await installModel());
  const t0 = Date.now();
  try {
    await startServer();
    console.log(`self-test passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log("start refused:", (e as Error).message);
    process.exitCode = 1;
  } finally {
    stopServer();
  }
})();
