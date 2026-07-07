export const HARNESS_VERSION = "0.1.0";

export const ALLOWED_TOOLS = ["read", "write", "edit", "ls", "find", "grep"] as const;
export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

export interface CharacterCard {
  name: string;
  version?: number | string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_message?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface RuntimeManifest {
  model?: string;
  provider?: string;
  character: string;
  systemPromptHash: string;
  harnessVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface TurnMeta {
  role: "user" | "assistant" | "control";
  piLeaf?: string;
  summary?: string;
  createdAt: string;
}

export interface SaveMeta {
  id: string;
  character: string;
  createdAt: string;
  updatedAt: string;
  currentBranch: string;
  turns: TurnMeta[];
}

export interface AppPaths {
  root: string;
  piHome: string;
  characters: string;
  saves: string;
}

export interface SavePaths {
  root: string;
  piSession: string;
  world: string;
  manifest: string;
  meta: string;
}
