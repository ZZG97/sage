import { createOpencodeClient } from "@opencode-ai/sdk";

const client = createOpencodeClient({
  baseUrl: "http://127.0.0.1:4111",
});

async function main() {
  const sessions = await client.session.list();
  console.log("Sessions:", sessions.data);

  const session = await client.session.create({});
  console.log("Created session:", session.data);

  if (session.data?.id) {
    const prompt = await client.session.prompt({
      body: {
        parts: [{ type: "text", text: "你好" }],
      },
      path: {
        id: session.data.id,
      },
    });
    console.log("Prompt response:", prompt.data);
  }
}

main();
