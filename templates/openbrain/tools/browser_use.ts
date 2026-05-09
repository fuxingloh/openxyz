import { mcp } from "openxyz/tools/mcp";
import { env } from "openxyz/env";

export default mcp({
  url: "https://api.browser-use.com/v3/mcp",
  headers: {
    "x-browser-use-api-key": env.BROWSER_USE_API_KEY.describe(
      "Browser Use cloud API key — create one at https://cloud.browser-use.com/settings",
    ),
  },
});
