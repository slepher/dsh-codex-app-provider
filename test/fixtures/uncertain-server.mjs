import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread" }, model: "model" } });
  if (request.method === "turn/start") {
    send({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } });
    if (process.argv[2] === "exit") {
      send({ id: request.id, result: { turn: { id: "turn", status: "inProgress" } } });
      setTimeout(() => process.exit(7), 20);
    }
  }
}).on("close", () => process.exit(0));
