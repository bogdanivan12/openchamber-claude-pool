import { createServer } from "./http.ts";
import { routes } from "./routes.ts";

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}

createServer(routes, token).listen(port, "127.0.0.1");
