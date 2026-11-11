// JSON worker fixture: no UIA import and no desktop or file actions.
import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.op === 'timeout') return;
  if (message.op === 'invalid') { process.stdout.write('invalid worker response\n'); return; }
  if (message.op === 'exit') { process.exit(9); return; }
  process.stdout.write(JSON.stringify({ id: message.id, ok: true, result: message.params }) + '\n');
});
process.stdin.on('end', () => process.exit(0));
