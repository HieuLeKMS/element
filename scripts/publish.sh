#!/bin/bash

set -euo pipefail
[[ ${DEBUG:-} ]] && set -x

HERE="$( cd "$( dirname "${BASH_SOURCE[0]}" )" > /dev/null && pwd )"
root=$HERE/..

cd $root

git config --global url."https://github.com".insteadOf git://github.com
git config --global url."https://${GITHUB_TOKEN}:x-oauth-basic@github.com/".insteadOf "https://github.com/"

branch=
if [[ $BUILDKITE_BRANCH ]]; then
  branch=$BUILDKITE_BRANCH

  ls -la $root

  # build optimisation, so docker images don't have to have the whole .git we feed it in via the bind mount
  cp -a /build/element-dot-git .git
  git reset --hard $BUILDKITE_BRANCH
else
  branch=$(git rev-parse --abbrev-ref HEAD)
fi


npmrc=$HOME/.npmrc
if [[ ! -f $npmrc ]]; then
	echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > $npmrc
fi

	cp -a /build/element-dot-git /app/.git

case $branch in
  beta|feature/open-source-everything)
    echo publishing beta
    yarn exec lerna -- version prerelease --force-publish --no-push --yes --ignore-changes scripts/publish.sh --allow-branch beta --allow-branch feature/open-source-everything --preid beta
    ;;
  master)
    echo publishing master
    yarn exec lerna -- version patch --force-publish --no-push --yes --ignore-changes scripts/publish.sh --allow-branch master
    ;;
  *)
    echo "branch is $branch which I won't publish"
    exit 0
esac

version=$(cat $root/lerna.json | jq .version)

cd $root/packages/element
./scripts/build.sh
npm publish --access public dist

cd $root/packages/cli
npm publish --access public

git push

# TODO brew publish
cd $root
yarn publish:brew
