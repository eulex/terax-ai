// Helpers for the LM Studio local-model integration: probe reachability,
// auto-launch the app/CLI when the server is down, and list the models the
// running server reports.
//
// The Rust side (`net.rs`) owns the actual HTTP probe, the model-list fetch
// (re-using the same blocked-host policy as `lm_ping`), and the per-OS app
// launch. This module is the thin TS orchestrator that the Settings panel
// and the status-bar picker share so neither hand-rolls its own poll loop.

import { invoke } from "@tauri-apps/api/core";

export type LmModel = {
  id: string;
  owned_by?: string;
};

export type LmReadyState =
  | "checking"
  | "launching"
  | "waiting"
  | "ready"
  | "failed";

export async function lmIsReachable(baseUrl: string): Promise<boolean> {
  const url = baseUrl.trim();
  if (!url) return false;
  try {
    const status = await invoke<number>("lm_ping", { baseUrl: url });
    // 2xx/4xx both mean "there's a server answering" — LM Studio returns 200
    // on /v1/models, but treat anything below 500 as "alive" so a future
    // hardening tweak (e.g. auth-protected models endpoint) still counts.
    return status > 0 && status < 500;
  } catch {
    return false;
  }
}

export async function lmLaunchApp(): Promise<void> {
  await invoke("lm_open_app");
}

export async function lmListModels(baseUrl: string): Promise<LmModel[]> {
  const url = baseUrl.trim();
  if (!url) return [];
  return await invoke<LmModel[]>("lm_list_models", { baseUrl: url });
}

// Probe → if down, launch LM Studio → poll until the server answers or the
// deadline passes. Returns true once /v1/models is reachable.
//
// `onState` lets the caller render a status pill without subscribing to a
// state machine; it fires `checking` → `launching` → `waiting` → `ready`/
// `failed`. If the server is already up, only `checking` and `ready` fire.
export async function lmEnsureReady(
  baseUrl: string,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    onState?: (state: LmReadyState) => void;
    signal?: AbortSignal;
  } = {},
): Promise<boolean> {
  const { timeoutMs = 30_000, intervalMs = 1500, onState, signal } = opts;
  onState?.("checking");
  if (await lmIsReachable(baseUrl)) {
    onState?.("ready");
    return true;
  }
  if (signal?.aborted) {
    onState?.("failed");
    return false;
  }

  onState?.("launching");
  try {
    await lmLaunchApp();
  } catch {
    onState?.("failed");
    return false;
  }

  onState?.("waiting");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      onState?.("failed");
      return false;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    if (await lmIsReachable(baseUrl)) {
      onState?.("ready");
      return true;
    }
  }
  onState?.("failed");
  return false;
}
