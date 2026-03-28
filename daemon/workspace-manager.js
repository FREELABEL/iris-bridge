/**
 * WorkspaceManager — Manages isolated task directories.
 *
 * Each task gets its own directory under the data dir:
 *   /data/tasks/{taskId}/
 *     .task.json          — task definition
 *     project/            — working directory for iris-code
 *     .output/            — collected output files
 */

const fs = require('fs')
const path = require('path')

class WorkspaceManager {
  constructor (dataDir) {
    this.dataDir = dataDir
    this.tasksDir = path.join(dataDir, 'tasks')

    // Ensure base directories exist
    fs.mkdirSync(this.tasksDir, { recursive: true })
  }

  /**
   * Create an isolated workspace for a task.
   */
  create (taskId, task) {
    const dir = path.join(this.tasksDir, taskId)
    const projectDir = path.join(dir, 'project')
    const outputDir = path.join(dir, '.output')

    fs.mkdirSync(projectDir, { recursive: true })
    fs.mkdirSync(outputDir, { recursive: true })

    // Write task definition
    fs.writeFileSync(
      path.join(dir, '.task.json'),
      JSON.stringify(task, null, 2),
      'utf-8'
    )

    return { dir, projectDir, outputDir }
  }

  /**
   * Collect output files from a completed task workspace.
   * Returns an array of { name, size, path } objects.
   */
  collectOutputFiles (taskId) {
    const dir = path.join(this.tasksDir, taskId)
    const projectDir = path.join(dir, 'project')
    const outputDir = path.join(dir, '.output')
    const files = []

    // Collect from project directory (generated code)
    if (fs.existsSync(projectDir)) {
      this._walkDir(projectDir, projectDir, files, 50) // max 50 files
    }

    // Collect from output directory (explicit outputs)
    if (fs.existsSync(outputDir)) {
      this._walkDir(outputDir, outputDir, files, 20)
    }

    return files
  }

  /**
   * Remove a task workspace.
   */
  cleanup (taskId) {
    const dir = path.join(this.tasksDir, taskId)
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
      console.log(`[workspace] Cleaned up: ${taskId}`)
    }
  }

  /**
   * List active (non-cleaned-up) task workspaces.
   */
  listActive () {
    if (!fs.existsSync(this.tasksDir)) return []

    return fs.readdirSync(this.tasksDir)
      .filter((name) => {
        const taskPath = path.join(this.tasksDir, name, '.task.json')
        return fs.existsSync(taskPath)
      })
  }

  /**
   * Recursively walk a directory and collect file info.
   */
  _walkDir (dir, baseDir, files, maxFiles) {
    if (files.length >= maxFiles) return

    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= maxFiles) break

      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(baseDir, fullPath)

      // Skip hidden dirs (except .output), node_modules, etc.
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        this._walkDir(fullPath, baseDir, files, maxFiles)
      } else {
        const stats = fs.statSync(fullPath)
        // Skip files > 1MB
        if (stats.size > 1024 * 1024) continue

        files.push({
          name: relativePath,
          size: stats.size,
          content: stats.size < 100 * 1024
            ? fs.readFileSync(fullPath, 'utf-8')
            : '[file too large — content omitted]'
        })
      }
    }
  }
}

module.exports = { WorkspaceManager }
