// Récupère la liste des fichiers (blobs) dans le répertoire racine de la branche
async function listFiles(octokit, owner, repo, branch) {
  const { data: tree } = await octokit.rest.git.getTree({
    owner, repo, tree_sha: branch, recursive: true
  });
  return tree.tree.filter(item => item.type === 'blob');
}

// Récupère le contenu d'un fichier sur une branche
async function getFileContent(octokit, owner, repo, path, branch) {
  const { data } = await octokit.rest.repos.getContent({
    owner, repo, path, ref: branch
  });
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

module.exports = {
  addReaction,
  createBranch,
  createPR,
  commitChanges,
  commentOnPR,
  listFiles,
  getFileContent
};