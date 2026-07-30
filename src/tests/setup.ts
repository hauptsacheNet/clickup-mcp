import { fetch as undiciFetch } from "undici";

/**
 * Test preload: make undici's MockAgent able to intercept our requests again.
 *
 * The source uses Node's global `fetch`, which is backed by the undici copy bundled
 * *inside* Node. The `undici` npm package we use for mocking has its own separate
 * instance, so `setGlobalDispatcher(new MockAgent())` never affected global fetch -
 * every test silently made real network calls and failed on DNS instead of on
 * assertions. Pointing global fetch at the npm undici puts both on the same instance.
 */
(globalThis as any).fetch = undiciFetch;
