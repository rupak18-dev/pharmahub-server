import { execSync } from "node:child_process";

const port = process.argv[2] ?? "5000";

function run(cmd) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"], shell: true })
    .toString()
    .trim();
}

let pids = [];

try {
  if (process.platform === "win32") {
    const out = run(`netstat -ano | findstr :${port}`);
    pids = [...new Set(out.split(/\r?\n/).map((l) => l.match(/LISTENING\s+(\d+)\s*$/)?.[1]).filter(Boolean))];
    for (const pid of pids) run(`taskkill /PID ${pid} /F`);
  } else {
    const out = run(`lsof -ti :${port} -sTCP:LISTEN`);
    pids = out ? out.split(/\r?\n/) : [];
    for (const pid of pids) run(`kill -9 ${pid}`);
  }
} catch {
  pids = [];
}

if (pids.length) {
  console.log(`Freed port ${port}: killed ${pids.join(", ")}`);
} else {
  console.log(`Port ${port} is already free`);
}
