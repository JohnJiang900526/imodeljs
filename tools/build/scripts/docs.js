/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
"use strict";

process.env.NODE_ENV = "prod";

const paths = require("./config/paths");
const path = require("path");
const cpx = require("cpx");
const fs = require("fs");
const { spawn, handleInterrupts } = require("./utils/simpleSpawn");
const { validateTags } = require("./utils/validateTags");
const argv = require("yargs").argv;


// Makes the script crash on unhandled rejections instead of silently
// ignoring them. In the future, promise rejections that are not handled will
// terminate the Node.js process with a non-zero exit code.
process.on("unhandledRejection", err => {
    throw err;
});

const source = (argv.source === undefined) ? paths.appSrc : argv.source;
const out = (argv.out === undefined) ? paths.appDocs : argv.out;
const json = (argv.json === undefined) ? paths.appJsonDocs : argv.json;

const baseUrlOptions = (argv.baseUrl === undefined) ? [] : ["--baseUrl", argv.baseUrl];
const includeOptions = (argv.includes === undefined) ? [] : ["--includes", argv.includes];

let excludeList = "**/node_modules/**/*,**/test/**/*";
if (argv.excludes !== undefined)
    excludeList += ",**/" + argv.excludes + "/**/*";

let outputOptions = [
    "--json", json
];

if (argv.onlyJson === undefined)
    outputOptions = outputOptions.concat(["--out", out]);

const readmeOption = (argv.readme === undefined) ? "none" : argv.readme;

const options = [
    "--excludePrivate",
    "--experimentalDecorators",
    "--excludeExternals",
    "--excludeNotExported",
    "--ignoreCompilerErrors",
    "--hideGenerator"
]

if (argv.name) options.push("--name", argv.name);

if (argv.theme) options.push("--theme", argv.theme);

const args = [
    path.resolve(process.cwd(), source),
    ...options,
    "--exclude", [excludeList],
    ...outputOptions,
    "--mode", "modules",
    "--readme", readmeOption,
    "--module", "commonjs",
    "--plugin", "typedoc-plugin-external-module-name,typedoc-plugin-internal-external",
    "--external-aliases", "alpha,internal",
    "--internal-aliases", "UNUSED",
    ...baseUrlOptions,
    ...includeOptions
]

console.log("Arguments to TypeDoc: " + JSON.stringify(args, null, 2));

spawn(path.resolve(process.cwd(), "node_modules/.bin/typedoc"), args).then((code) => {
    // Copy index.ts file to json output folder and rename to index.ts if a file is specified. Needed by bemetalsmith for adding descriptions
    const outputDir = path.parse(json).dir;
    if (argv.tsIndexFile) {
        cpx.copySync(path.join(source, argv.tsIndexFile), outputDir);
        fs.renameSync(path.join(outputDir, argv.tsIndexFile), path.join(outputDir, 'index.ts'));
    }
    // Copy CHANGELOG.json to json output folder
    if (fs.existsSync(path.join(process.cwd(), 'CHANGELOG.json'))) {
        cpx.copySync(path.join(process.cwd(), 'CHANGELOG.json'), outputDir);
    }

    if (code === 0) {
        let tagErrors = validateTags(json);
        if (tagErrors.toString()) {
            console.error(`JSON contains invalid tags: ${JSON.stringify(tagErrors)}`);
            fs.unlink(json);
            console.log(`JSON removed from ${json}`)
            code = 5;
        }
    }
    process.exit(code)
});
handleInterrupts();
