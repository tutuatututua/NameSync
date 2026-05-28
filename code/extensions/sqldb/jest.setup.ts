import * as path from 'path';

// Ensure process.cwd() is the SQLDB package root so migration file globs
// resolve correctly regardless of where jest is invoked from.
process.chdir(path.resolve(__dirname));
