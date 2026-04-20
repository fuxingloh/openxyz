import { mcp } from "openxyz/tools/mcp";
import { readEnv } from "openxyz/env";

export default mcp({
  url: "https://mcp.linear.app/mcp",
  headers: {
    Authorization: `Bearer ${readEnv("LINEAR_API_KEY", {
      description: "Linear API key — https://linear.app/settings/account/security",
    })}`,
  },
});
