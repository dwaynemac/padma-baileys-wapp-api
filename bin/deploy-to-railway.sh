current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" != "main" ]; then
  echo "You must be on the main branch to deploy to Railway"
  exit 1
fi
git stash --include-untracked
git checkout production
git merge "$current_branch"
git push
git checkout "$current_branch"
git stash pop
