const fs = require('node:fs');

function replaceOnce(source, search, replacement, label) {
  const index = source.indexOf(search);
  if (index < 0) throw new Error(`${label}: source fragment not found`);
  if (source.indexOf(search, index + search.length) >= 0) throw new Error(`${label}: source fragment is not unique`);
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

function transform(file, edits) {
  let source = fs.readFileSync(file, 'utf8');
  for (const [label, search, replacement] of edits) source = replaceOnce(source, search, replacement, label);
  fs.writeFileSync(file, source);
  console.log(`updated ${file}`);
}

transform('app.js', [
  ['delete scene operation start',
`    if (!yes) return;\n    const initial = currentState(), episodeId = selectedEpisodeId, workId = initial.work.id;`,
`    if (!yes) return;\n    const finishOperation = beginOperation();\n    try {\n      const initial = currentState(), episodeId = selectedEpisodeId, workId = initial.work.id;`],
  ['delete scene operation finish',
`    syncImageUrls();\n  }\n  function renderScenes(episode, force) {`,
`      syncImageUrls();\n    } finally {\n      finishOperation();\n    }\n  }\n  function renderScenes(episode, force) {`]
]);

transform('characters.js', [
  ['character image removal operation start',
`    async function removeImage(character, imageId) {\n      const latest = getState(), current = latest.characters.find(item => item.id === character.id), workId = latest.work.id;`,
`    async function removeImage(character, imageId) {\n      const finishOperation = workspace.beginOperation();\n      try {\n        const latest = getState(), current = latest.characters.find(item => item.id === character.id), workId = latest.work.id;`],
  ['character image removal operation finish',
`      await render();\n    }\n\n    async function openCharacter(characterId) {`,
`        await render();\n      } finally {\n        finishOperation();\n      }\n    }\n\n    async function openCharacter(characterId) {`]
]);

transform('plot.js', [
  ['plot image removal operation start',
`    async function removeImage(scene, imageId) {\n      const state = getState(), current = sceneAt(scene.id) || scene, workId = state.work.id;`,
`    async function removeImage(scene, imageId) {\n      const finishOperation = workspace.beginOperation();\n      try {\n        const state = getState(), current = sceneAt(scene.id) || scene, workId = state.work.id;`],
  ['plot image removal operation finish',
`      await render();\n    }\n\n    async function moveSelectedScene(destination) {`,
`        await render();\n      } finally {\n        finishOperation();\n      }\n    }\n\n    async function moveSelectedScene(destination) {`],
  ['move selected scene operation start',
`    async function moveSelectedScene(destination) {\n      const scope = activeScope(), source = await ensureBucket(scope), scene = source.find(item => item.id === selectedSceneId);`,
`    async function moveSelectedScene(destination) {\n      const finishOperation = workspace.beginOperation();\n      try {\n        const scope = activeScope(), source = await ensureBucket(scope), scene = source.find(item => item.id === selectedSceneId);`],
  ['move selected scene operation finish',
`      await render();\n    }\n\n    async function render() {`,
`        await render();\n      } finally {\n        finishOperation();\n      }\n    }\n\n    async function render() {`],
  ['episode chapter move operation start',
`          void (async () => {\n            const sourceMetas = sortedEpisodes(snapshot, meta.chapterId).filter(item => item.id !== meta.id);`,
`          void (async () => {\n            const finishOperation = workspace.beginOperation();\n            try {\n              const sourceMetas = sortedEpisodes(snapshot, meta.chapterId).filter(item => item.id !== meta.id);`],
  ['episode chapter move operation finish',
`            selectedChapterId = chapterId; mode = 'episode'; void render();\n          })().catch(error => workspace.toast(\`話を移動できませんでした：\${error.message}\`));`,
`              selectedChapterId = chapterId; mode = 'episode'; void render();\n            } finally {\n              finishOperation();\n            }\n          })().catch(error => workspace.toast(\`話を移動できませんでした：\${error.message}\`));`],
  ['scene add operation start',
`      sceneHeading.append(makeButton('＋ シーン', async () => {\n        const latest = getState(), scopeNow = activeScope(), items = await ensureBucket(scopeNow);`,
`      sceneHeading.append(makeButton('＋ シーン', async () => {\n        const finishOperation = workspace.beginOperation();\n        try {\n          const latest = getState(), scopeNow = activeScope(), items = await ensureBucket(scopeNow);`],
  ['scene add operation finish',
`        await render();\n      }, 'accent'));`,
`          await render();\n        } finally {\n          finishOperation();\n        }\n      }, 'accent'));`]
]);
