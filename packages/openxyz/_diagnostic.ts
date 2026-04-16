// Diagnostic module for bisecting the Vercel `ReadOnlyFileSystem` crash.
// Stage 1 (harness/openxyz) was the culprit — now splitting it into its
// transitive deps to find the specific module doing a top-level write.

export async function runBisect(): Promise<void> {
  console.log("[stage] 0 _diagnostic.ts top");

  console.log("[stage] 1 importing chat …");
  await import("chat");
  console.log("[stage] 1 ok");

  console.log("[stage] 2 importing ai …");
  await import("ai");
  console.log("[stage] 2 ok");

  console.log("[stage] 3 importing @openxyz/harness/tools/filesystem (→ just-bash) …");
  await import("@openxyz/harness/tools/filesystem");
  console.log("[stage] 3 ok");

  console.log("[stage] 4 importing @openxyz/harness/tools/web …");
  await import("@openxyz/harness/tools/web");
  console.log("[stage] 4 ok");

  console.log("[stage] 4.5 importing gray-matter (suspected culprit) …");
  await import("gray-matter");
  console.log("[stage] 4.5 ok");

  console.log("[stage] 5 importing @openxyz/harness/tools/skill …");
  await import("@openxyz/harness/tools/skill");
  console.log("[stage] 5 ok");

  console.log("[stage] 6 importing @openxyz/harness/agents/factory …");
  await import("@openxyz/harness/agents/factory");
  console.log("[stage] 6 ok");

  console.log("[stage] 7 importing @openxyz/harness/channels …");
  await import("@openxyz/harness/channels");
  console.log("[stage] 7 ok");

  console.log("[stage] 8 importing @openxyz/harness/databases (→ pg, state-pg) …");
  await import("@openxyz/harness/databases");
  console.log("[stage] 8 ok");

  console.log("[stage] 9 importing @openxyz/harness/openxyz …");
  await import("@openxyz/harness/openxyz");
  console.log("[stage] 9 ok");

  console.log("[stage] 10 importing @ai-sdk/amazon-bedrock …");
  await import("@ai-sdk/amazon-bedrock");
  console.log("[stage] 10 ok");

  console.log("[stage] 11 importing @ai-sdk/openai-compatible …");
  await import("@ai-sdk/openai-compatible");
  console.log("[stage] 11 ok");

  console.log("[stage] 12 importing @chat-adapter/telegram …");
  await import("@chat-adapter/telegram");
  console.log("[stage] 12 ok");

  console.log("[stage] all imports resolved");
}
