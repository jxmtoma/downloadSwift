// Wires the two halves together on browsers whose background context is a page
// rather than a service worker. Both are imported statically: a service worker
// is forbidden from calling import(), and reaching for one at run time turned a
// wrong guess about the context into a hard failure of every download.
//
// background.html loads service-worker.mjs before this file, so detection is
// already registered by the time anything here runs. Modules are evaluated
// once, so importing it again here is the same instance, not a second copy.
import { handleServiceWorkerMessage, setBackgroundPageHandler } from "./service-worker.mjs";
import { handleOffscreenMessage, setServiceWorkerMessageHandler } from "./offscreen.js";

setBackgroundPageHandler((message) => handleOffscreenMessage(message, true));
setServiceWorkerMessageHandler(handleServiceWorkerMessage);
