import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

test("when the installed revision differs, rejects the plugin", () => {
  // Arrange
  const home = mkdtempSync(join(tmpdir(), "omp-worklog-release-"))
  const pluginRoot = join(home, ".omp", "plugins")
  const packagePath = join(pluginRoot, "node_modules", "omp-worklog", "package.json")
  const version = execFileSync("node", ["-p", "require('./package.json').version"], { encoding: "utf8" }).trim()
  mkdirSync(join(pluginRoot, "node_modules", "omp-worklog"), { recursive: true })
  writeFileSync(packagePath, JSON.stringify({ name: "omp-worklog", version }))
  writeFileSync(join(pluginRoot, "bun.lock"), JSON.stringify({
    packages: {
      "omp-worklog": ["omp-worklog@github:klondikemarlen/omp-worklog#0000000"],
    },
  }))

  try {
    // Act
    const result = spawnSync("bash", ["bin/verify-plugin-release"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    })
    // Assert
    assert.equal(result.status, 1)
    assert.match(result.stderr, new RegExp(`Expected installed omp-worklog@${version} from Git revision`))
    assert.match(result.stderr, new RegExp(`found omp-worklog@${version} at ${packagePath} resolved from Git revision 0000000`))
  } finally {
    rmSync(home, { force: true, recursive: true })
  }
})

const fakeOmpSource = `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const statePath = process.env.OMP_TEST_STATE
const state = JSON.parse(fs.readFileSync(statePath, "utf8"))
const [, action, ...args] = process.argv.slice(2)
if (process.env.OMP_FAIL_ACTION === "export" && action === "config" && args[0] === "list") process.exit(1)
if (process.env.OMP_FAIL_ACTION === "install" && action === "install") {
  console.error("Sensitive subprocess diagnostic")
  process.exit(1)
}
if (action === "list") {
  console.log(JSON.stringify({ npm: state.installed.map(name => ({ name })) }))
} else if (action === "uninstall") {
  state.installed = state.installed.filter(name => name !== args[0])
  delete state.settings[args[0]]
  fs.writeFileSync(statePath, JSON.stringify(state))
} else if (action === "install") {
  state.installed.push("omp-worklog")
  state.source = args.at(-1)
  fs.writeFileSync(statePath, JSON.stringify(state))
} else if (action === "config" && args[0] === "list") {
  const overridesPath = path.join(process.cwd(), ".omp", "plugin-overrides.json")
  const overrides = fs.existsSync(overridesPath) ? JSON.parse(fs.readFileSync(overridesPath, "utf8")) : {}
  const settings = { ...state.settings[args[1]], ...overrides.settings?.[args[1]] }
  console.log(JSON.stringify({ settings, schema: { defaultHours: { default: 7 } } }))
} else if (action === "config" && args[0] === "set") {
  state.settings[args[1]] ??= {}
  state.settings[args[1]][args[2]] = args[2] === "defaultHours" ? Number(args[3]) : args[3]
  fs.writeFileSync(statePath, JSON.stringify(state))
}
`

function releaseFixture(t) {
  const home = mkdtempSync(join(tmpdir(), "omp-worklog-release-"))
  const bin = join(home, "bin")
  const project = join(home, "project")
  mkdirSync(bin)
  mkdirSync(join(project, ".omp"), { recursive: true })
  const omp = join(bin, "omp")
  writeFileSync(omp, fakeOmpSource)
  chmodSync(omp, 0o755)
  t.after(() => rmSync(home, { force: true, recursive: true }))

  return {
    home,
    project,
    statePath: join(home, "state.json"),
    env: { ...process.env, HOME: home, TMPDIR: home, OMP_TEST_STATE: join(home, "state.json"), PATH: `${bin}:${process.env.PATH}` },
  }
}

const releaseScript = fileURLToPath(new URL("../bin/release-plugin", import.meta.url))

test("when reinstalling, it preserves explicit user values without promoting project overrides or defaults", t => {
  // Arrange
  const fixture = releaseFixture(t)
  const settings = {
    projectTimeMappings: '{"Demo":{"project":"Private Destination","task":"Development"}}',
    defaultHours: 6.5,
    holidayRegions: "",
  }
  writeFileSync(fixture.statePath, JSON.stringify({ installed: ["omp-worklog"], settings: { "omp-worklog": settings } }))
  writeFileSync(join(fixture.project, ".omp", "plugin-overrides.json"), JSON.stringify({
    settings: { "omp-worklog": { projectTimeMappings: '{"Demo":{"project":"Project Override","task":"Review"}}' } },
  }))

  // Act
  const result = spawnSync(releaseScript, { cwd: fixture.project, env: fixture.env, encoding: "utf8" })

  // Assert
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(readFileSync(fixture.statePath, "utf8")), {
    installed: ["omp-worklog"],
    settings: { "omp-worklog": settings },
    source: "github:klondikemarlen/omp-worklog",
  })
  assert.doesNotMatch(result.stdout + result.stderr, /Private Destination|Project Override/)
})

test("when settings export fails, it leaves the installed plugin and configuration intact", t => {
  // Arrange
  const fixture = releaseFixture(t)
  const state = { installed: ["omp-worklog"], settings: { "omp-worklog": { defaultHours: 6.5 } } }
  writeFileSync(fixture.statePath, JSON.stringify(state))

  // Act
  const result = spawnSync(releaseScript, {
    cwd: fixture.project,
    env: { ...fixture.env, OMP_FAIL_ACTION: "export" },
    encoding: "utf8",
  })

  // Assert
  assert.equal(result.status, 1)
  assert.deepEqual(JSON.parse(readFileSync(fixture.statePath, "utf8")), state)
})

test("when installation fails after uninstall, it retains an owner-only recovery snapshot", t => {
  // Arrange
  const fixture = releaseFixture(t)
  const settings = { projectTimeMappings: '{"Demo":{"project":"Private Destination","task":"Development"}}' }
  writeFileSync(fixture.statePath, JSON.stringify({ installed: ["omp-worklog"], settings: { "omp-worklog": settings } }))

  // Act
  const result = spawnSync(releaseScript, {
    cwd: fixture.project,
    env: { ...fixture.env, OMP_FAIL_ACTION: "install" },
    encoding: "utf8",
  })

  // Assert
  assert.equal(result.status, 1)
  const snapshotPath = /Recover saved user settings from (.+)\./.exec(result.stderr)[1]
  assert.deepEqual(JSON.parse(readFileSync(snapshotPath, "utf8")), settings)
  assert.equal(statSync(snapshotPath).mode & 0o777, 0o600)
  assert.equal(statSync(join(snapshotPath, "..")).mode & 0o777, 0o700)
  assert.doesNotMatch(result.stdout + result.stderr, /Private Destination|Sensitive subprocess diagnostic/)
})

test("when only the retired plugin is installed, it replaces it with OMP Worklog", t => {
  // Arrange
  const fixture = releaseFixture(t)
  writeFileSync(fixture.statePath, JSON.stringify({ installed: ["harvest-worklog"], settings: {} }))

  // Act
  const result = spawnSync(releaseScript, { cwd: fixture.project, env: fixture.env, encoding: "utf8" })

  // Assert
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(readFileSync(fixture.statePath, "utf8")), {
    installed: ["omp-worklog"],
    settings: {},
    source: "github:klondikemarlen/omp-worklog",
  })
})

test("when no worklog plugin is installed, it installs without setting defaults", t => {
  // Arrange
  const fixture = releaseFixture(t)
  writeFileSync(fixture.statePath, JSON.stringify({ installed: [], settings: {} }))

  // Act
  const result = spawnSync(releaseScript, { cwd: fixture.project, env: fixture.env, encoding: "utf8" })

  // Assert
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(readFileSync(fixture.statePath, "utf8")), {
    installed: ["omp-worklog"],
    settings: {},
    source: "github:klondikemarlen/omp-worklog",
  })
})
