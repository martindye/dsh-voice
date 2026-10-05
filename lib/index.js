import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
//#region src/index.ts
/**
* Host half of @martin/dsh-voice: the metrics sink.
*
* The browser voice UI (src/client/metrics.ts) forwards one entry per
* completed voice turn; each entry is appended as a JSON line to
* ~/.dsh/logs/voice-metrics.log, where the numbers behind "the phone feels
* slow" can be analysed afterwards.
*/
const REMOTE_METHODS_KEY = "@deepseek-ai/dsh-typert-protocol/remote-methods";
function metricsLogPath() {
	return path.join(os.homedir(), ".dsh", "logs", "voice-metrics.log");
}
var VoiceMetricsController = class {
	typertRemote = Object.freeze({
		service: this,
		serviceKey: "voiceMetricsController",
		namespace: "voiceMetrics"
	});
	/** One entry per completed voice turn (a JSON object from the client). */
	log(entry) {
		try {
			appendFileSync(metricsLogPath(), (typeof entry === "string" ? entry : JSON.stringify(entry)) + "\n", "utf8");
		} catch {}
		return { ok: true };
	}
};
Object.defineProperty(VoiceMetricsController.prototype, REMOTE_METHODS_KEY, { value: Object.freeze({
	version: 1,
	methods: Object.freeze([{
		method: "log",
		invocation: { kind: "direct" }
	}])
}) });
function apply(ctx) {
	ctx.provide("voiceMetricsController", new VoiceMetricsController());
}
//#endregion
export { apply };
