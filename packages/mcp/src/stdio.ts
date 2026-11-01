import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { SessionManager } from "./session.js";
import { setClientSource } from "./tools.js";

const empty = { type: "object" as const, properties: {} };

export async function startStdioServer(): Promise<void> {
  const session = new SessionManager();
  await session.start();
  // Every tool call goes through the one live client, so the keep-alive covers it.
  setClientSource(() => session.client());

  const server = createMcpServer({
    instructions:
      "When a tool says the user must sign in, call clalit_login and give the user the link it returns; the user signs in on that page (ID, CAPTCHA, SMS code). Never ask for the ID or codes in the chat.",
    tools: [
      {
        name: "clalit_login",
        description:
          "Get the link where the user signs in to Clalit (ID, CAPTCHA and SMS code are typed on that page, never in the chat). Returns the current status when already signed in.",
        inputSchema: empty,
      },
      {
        name: "clalit_session_status",
        description: "Whether this server is signed in to Clalit, since when, until when, and the sign-in link when it is not.",
        inputSchema: empty,
      },
      {
        name: "clalit_logout",
        description: "Sign out of Clalit here: forget the saved session.",
        inputSchema: empty,
      },
    ],
    async call(name) {
      if (name === "clalit_login") {
        const status = await session.status();
        if (status.state === "signed_in") return { ...status, message: "Already signed in." };
        return {
          ...status,
          message: `Ask the user to open ${status.signInUrl} and sign in there, then try the request again.`,
        };
      }
      if (name === "clalit_session_status") return session.status();
      if (name === "clalit_logout") {
        await session.signOut();
        return { state: "signed_out", message: "Signed out; the saved session is gone." };
      }
      return undefined;
    },
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => session.stop();
  await server.connect(transport);
}
