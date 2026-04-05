function attachCommandResult(command, result) {
  let current = command;
  while (current) {
    current._synclisticResult = result;
    current = current.parent;
  }

  return result;
}

function toExitCode(success) {
  return success ? 0 : 1;
}

module.exports = {
  attachCommandResult,
  toExitCode
};
