'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const manifest=require('../package.json');
fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
const tool=path.join(root,'node_modules','@vscode','vsce','vsce');
execFileSync(process.execPath,[tool,'package','--out',path.join(root,'artifacts',`${manifest.name}-${manifest.version}.vsix`)],{cwd:root,stdio:'inherit'});
