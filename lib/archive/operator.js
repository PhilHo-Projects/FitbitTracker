function positiveBatchSize(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5000) {
    throw new Error('--batch-size must be between 1 and 5000');
  }
  return parsed;
}
function optionValue(args, index, name) {
  const argument = args[index];
  if (argument === name) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return { value, consumed: 2 };
  }
  if (argument.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1);
    if (!value) throw new Error(`${name} requires a value`);
    return { value, consumed: 1 };
  }
  return null;
}

export function parseHealthArchiveArgs(args) {
  const command = args[0];
  if (!['list', 'verify', 'extract', 'import', 'run'].includes(command)) {
    throw new Error('Health archive command must be list, verify, extract, import, or run');
  }
  const result = { command };
  if (command === 'run') Object.assign(result, { execute: false, prune: false });
  if (command === 'import') result.allowProductionTarget = false;

  for (let index = 1; index < args.length;) {
    const argument = args[index];
    if (argument === '--execute' && command === 'run') {
      result.execute = true;
      index += 1;
      continue;
    }
    if (argument === '--prune' && command === 'run') {
      result.prune = true;
      index += 1;
      continue;
    }
    if (argument === '--allow-production-target' && command === 'import') {
      result.allowProductionTarget = true;
      index += 1;
      continue;
    }
    const definitions = [
      ['--id', 'id', ['verify', 'extract', 'import']],
      ['--output', 'outputDirectory', ['extract']],
      ['--target-database-url', 'targetDatabaseUrl', ['import']],
      ['--batch-size', 'batchSize', ['import']],
      ['--source-account', 'sourceAccountId', ['list', 'run']],
      ['--month', 'archiveMonth', ['list', 'run']],
      ['--state', 'state', ['list']],
    ];
    let matched = false;
    for (const [name, property, commands] of definitions) {
      if (!commands.includes(command)) continue;
      const parsed = optionValue(args, index, name);
      if (!parsed) continue;
      result[property] = property === 'batchSize' ? positiveBatchSize(parsed.value) : parsed.value;
      index += parsed.consumed;
      matched = true;
      break;
    }
    if (!matched) throw new Error(`Unknown ${command} option: ${argument}`);
  }

  if (command === 'run' && result.prune && !result.execute) {
    throw new Error('--prune requires --execute');
  }
  if (['verify', 'extract', 'import'].includes(command) && !result.id) {
    throw new Error(`${command} requires --id`);
  }
  if (command === 'extract' && !result.outputDirectory) throw new Error('extract requires --output');
  if (command === 'import' && !result.targetDatabaseUrl) {
    throw new Error('import requires --target-database-url');
  }
  if (command === 'run' && (!result.sourceAccountId || !result.archiveMonth)) {
    throw new Error('run requires --source-account and --month');
  }
  if (command === 'import' && result.batchSize === undefined) delete result.batchSize;
  if (command === 'import' && !result.allowProductionTarget) delete result.allowProductionTarget;
  return result;
}
