import type { BbNavigate } from "@get-bb/plugin-sdk/app";

export const BOTS_NAV_PANEL_ID = "bots";

const THREAD_SUBPATH = /^thread\/([^/]+)$/;

export function botsThreadIdFromSubPath(subPath: string): string | null {
  const match = THREAD_SUBPATH.exec(subPath.trim());
  return match?.[1] ?? null;
}

export function botsThreadSubPath(threadId: string): string {
  return `thread/${threadId}`;
}

export function botsPanelNavigateCall(threadId: string) {
  return {
    method: "toPluginPanel" as const,
    path: BOTS_NAV_PANEL_ID,
    options: { subPath: botsThreadSubPath(threadId) },
  };
}

type NavClick = { metaKey?: boolean; ctrlKey?: boolean };

let openCreateBotHandler: (() => void) | null = null;

export function registerBotsCreateBotHandler(handler: (() => void) | null): void {
  openCreateBotHandler = handler;
}

export function requestBotsCreateBot(): void {
  openCreateBotHandler?.();
}

export function openBotsThread(
  navigate: BbNavigate,
  threadId: string,
  event?: NavClick,
): void {
  const split = Boolean(event?.metaKey || event?.ctrlKey);
  if (split) {
    navigate.toThread(threadId, { split: true });
    return;
  }
  navigate.toPluginPanel(BOTS_NAV_PANEL_ID, { subPath: botsThreadSubPath(threadId) });
}
