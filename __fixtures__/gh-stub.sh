#!/usr/bin/env bash
#
# gh-stub.sh — faux binaire `gh`, injecté par la variable GH_CLI.
#
# Comportement par défaut : écrit « [] » sur stdout et sort en 0. C'est ce qu'il
# faut à `gh pr list --json number`, et c'est pour cela qu'on n'utilise jamais
# GH_CLI=/bin/true : avec un stdout vide, JSON.parse('') lève.
#
# Tous les cas particuliers passent par des VARIABLES D'ENVIRONNEMENT, jamais par
# un stub de plus.
#
# ─── Variables de scénario ────────────────────────────────────────────────────
#
#   GH_STUB_SCENARIO            Scénario global. Valeurs reconnues :
#                                 nominal                  (défaut)
#                                   - `pr list`   -> []            (aucune PR ouverte)
#                                   - `git/ref/heads/…` -> 404      (branche absente)
#                                   - permission  -> GH_STUB_PERMISSION
#                                 pr-ouverte
#                                   `pr list` renvoie une PR ouverte -> la garde
#                                   doit refuser (lot 2, étape 7).
#                                 branche-distante-existe
#                                   `gh api …/git/ref/heads/<b>` répond 200 -> la
#                                   garde ne refuse pas, le lot 3a réutilise la
#                                   branche (R9).
#                                 permission-refusee
#                                   toute demande de permission répond 404 -> la
#                                   garde doit être fail-closed (lot 2, étage 2).
#                                 echec
#                                   TOUTE commande sort en GH_STUB_CODE_SORTIE.
#
#   GH_STUB_PERMISSION          Permission renvoyée par
#                               `gh api repos/…/collaborators/<login>/permission`.
#                               Défaut : « admin ». Mettre « read » ou « triage »
#                               pour exercer le refus de l'étage 2.
#
#   GH_STUB_LOGINS_AUTORISES    Liste de logins séparés par des virgules. Si elle
#                               est renseignée, seuls ces logins obtiennent
#                               GH_STUB_PERMISSION ; les autres reçoivent un 404.
#                               Vide (défaut) = tout le monde est autorisé.
#                               C'est ce qui permet de tester l'étage 2 bis
#                               (« mode consigne restreinte ») avec une seule
#                               fixture : le commentateur est autorisé, l'auteur
#                               de l'issue non.
#
#   GH_STUB_NUMERO_PR           Numéro de PR utilisé par `pr create` et par le
#                               scénario pr-ouverte. Défaut : 1.
#
#   GH_STUB_CODE_SORTIE         Code de sortie du scénario « echec ». Défaut : 1.
#
#   GH_STUB_JOURNAL             Fichier où l'argv de chaque appel est journalisé.
#                               Défaut : "${TMPDIR:-/tmp}/gh-stub-journal".
#                               Chaque test doit en fixer un qui lui est propre,
#                               sinon les appels de deux tests se mélangent.
#
# ─── Format du journal ────────────────────────────────────────────────────────
#
# Un appel = les arguments séparés par un octet NUL (\0), suivis d'un octet
# « record separator » (\036). Ni échappement ni guillemets : un argument qui
# contient des retours à la ligne (le corps d'une issue, un --body) est restitué
# tel quel. Lecture côté Node :
#
#   const appels = fs.readFileSync(journal, 'utf8')
#     .split('\x1e').filter(Boolean)
#     .map(r => r.split('\0').filter(s => s !== ''));
#
# `appels.length` est le nombre d'appels à `gh`. Chaque appel est un tableau
# d'arguments. Un résumé lisible part aussi sur stderr, pour les logs de job.

set -uo pipefail

journal="${GH_STUB_JOURNAL:-${TMPDIR:-/tmp}/gh-stub-journal}"
mkdir -p "$(dirname "$journal")" 2>/dev/null || true
{ printf '%s\0' "$@"; printf '\036'; } >>"$journal"
printf 'gh-stub: %s\n' "$*" >&2

scenario="${GH_STUB_SCENARIO:-nominal}"
numero_pr="${GH_STUB_NUMERO_PR:-1}"
depot="${GITHUB_REPOSITORY:-proprietaire/depot}"

if [ "$scenario" = "echec" ]; then
  printf 'gh-stub: échec simulé (scénario « echec »)\n' >&2
  exit "${GH_STUB_CODE_SORTIE:-1}"
fi

repondre_404() {
  printf 'gh: Not Found (HTTP 404)\n' >&2
  exit 1
}

# --- gh api repos/{o}/{r}/collaborators/{login}/permission --------------------
login=""
for arg in "$@"; do
  case "$arg" in
    */collaborators/*/permission)
      reste="${arg#*/collaborators/}"
      login="${reste%/permission}"
      ;;
  esac
done

if [ -n "$login" ]; then
  [ "$scenario" = "permission-refusee" ] && repondre_404
  autorises="${GH_STUB_LOGINS_AUTORISES:-}"
  if [ -n "$autorises" ]; then
    case ",${autorises}," in
      *",${login},"*) : ;;
      *) repondre_404 ;;
    esac
  fi
  permission="${GH_STUB_PERMISSION:-admin}"
  case " $* " in
    *" --jq "*|*" -q "*) printf '%s\n' "$permission" ;;
    *) printf '{"permission":"%s","user":{"login":"%s"}}\n' "$permission" "$login" ;;
  esac
  exit 0
fi

# --- gh api repos/{o}/{r}/git/ref/heads/<branche> -----------------------------
branche=""
for arg in "$@"; do
  case "$arg" in
    */git/ref/heads/*) branche="${arg#*/git/ref/heads/}" ;;
  esac
done

if [ -n "$branche" ]; then
  if [ "$scenario" = "branche-distante-existe" ]; then
    printf '{"ref":"refs/heads/%s","object":{"sha":"%s","type":"commit"}}\n' \
      "$branche" "0000000000000000000000000000000000000000"
    exit 0
  fi
  repondre_404
fi

# --- gh api …/reactions (réaction 👀) ----------------------------------------
for arg in "$@"; do
  case "$arg" in
    */reactions)
      printf '{"id":1,"content":"eyes"}\n'
      exit 0
      ;;
  esac
done

# --- sous-commandes ----------------------------------------------------------
case "${1:-} ${2:-}" in
  "pr list")
    if [ "$scenario" = "pr-ouverte" ]; then
      printf '[{"number":%s,"url":"https://github.com/%s/pull/%s","state":"OPEN"}]\n' \
        "$numero_pr" "$depot" "$numero_pr"
    else
      printf '[]\n'
    fi
    ;;
  "pr create"|"pr comment"|"issue comment"|"pr view")
    # `gh` écrit l'URL de l'objet créé ou consulté : c'est là que resolve.js lit
    # le numéro de PR.
    printf 'https://github.com/%s/pull/%s\n' "$depot" "$numero_pr"
    ;;
  *)
    printf '[]\n'
    ;;
esac

exit 0
