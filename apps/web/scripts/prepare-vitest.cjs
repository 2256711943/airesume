const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const projectRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(projectRoot, '.vitest-run');
const sourceDirs = ['composables', 'utils', 'types'];

function removeDirectory(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function ensureJsExtension(specifier) {
  if (path.extname(specifier)) {
    return specifier;
  }

  return `${specifier}.js`;
}

function rewriteRelativeImports(code) {
  return code
    .replace(/from\s+(['"])(\.{1,2}\/[^'"]+)\1/g, (_match, quote, specifier) => `from ${quote}${ensureJsExtension(specifier)}${quote}`)
    .replace(/import\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g, (_match, quote, specifier) => `import(${quote}${ensureJsExtension(specifier)}${quote})`)
    .replace(/export\s+\*\s+from\s+(['"])(\.{1,2}\/[^'"]+)\1/g, (_match, quote, specifier) => `export * from ${quote}${ensureJsExtension(specifier)}${quote}`)
    .replace(/export\s+\{([^}]+)\}\s+from\s+(['"])(\.{1,2}\/[^'"]+)\2/g, (_match, bindings, quote, specifier) => `export {${bindings}} from ${quote}${ensureJsExtension(specifier)}${quote}`);
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
      continue;
    }

    if (entry.isFile() && fullPath.endsWith('.ts') && !fullPath.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

function compileFile(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const relativePath = path.relative(projectRoot, filePath).replace(/\.ts$/, '.js');
  const outputPath = path.join(outputRoot, relativePath);
  let result;
  try {
    result = ts.transpileModule(sourceText, {
      fileName: filePath,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
        importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
        sourceMap: false,
      },
    });
  } catch (error) {
    console.error(`Failed to transpile ${filePath}`);
    throw error;
  }

  ensureDir(path.dirname(outputPath));
  fs.writeFileSync(outputPath, rewriteRelativeImports(result.outputText), 'utf8');
}

removeDirectory(outputRoot);
ensureDir(outputRoot);
fs.writeFileSync(path.join(outputRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));

for (const dir of sourceDirs) {
  const absDir = path.join(projectRoot, dir);
  for (const filePath of walk(absDir)) {
    compileFile(filePath);
  }
}
