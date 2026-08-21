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
#                                 pr-existe-deja
#                                   `pr create` ÉCHOUE avec le message de gh (« a
#                                   pull request already exists ») et `pr list`
#                                   renvoie la PR. C'est le cas réel : la garde ne
#                                   refuse que les PR ouvertes AU MOMENT où elle
#                                   passe. Sans ce scénario, le repli de
#                                   `publierInitial` sur `numeroPrOuverte()` n'a
#                                   aucun test, et le remplacer par « null »
#                                   resterait vert.
#                                 echec
#                                   TOUTE commande sort en GH_STUB_CODE_SORTIE.
#                                 echec-pr-list
#                                   ÉCHEC PARTIEL : seul `pr list` sort en
#                                   GH_STUB_CODE_SORTIE, la permission répond
#                                   normalement. « echec » ne suffit pas ici : il
#                                   fait tomber la permission la première, donc la
#                                   branche fail-closed de l'étape 7 du lot 2
#                                   (« état indéterminé sur `gh pr list` ») est
#                                   inatteignable et rester vert ne prouve rien.
#                                 echec-view
#                                   ÉCHEC PARTIEL : seule la LECTURE des
#                                   commentaires (`pr view` / `issue view
#                                   --json comments`) sort en GH_STUB_CODE_SORTIE.
#                                   `pr list` et les commentaires répondent
#                                   normalement. C'est le seul moyen d'atteindre la
#                                   dégradation de `rendre-compte.js` — publier sans
#                                   avoir pu contrôler l'absence de doublon — sans
#                                   faire tomber la résolution de la PR au passage.
#                                 echec-commentaire
#                                   ÉCHEC PARTIEL : seule la PUBLICATION
#                                   (`pr comment` / `issue comment`) sort en
#                                   GH_STUB_CODE_SORTIE, les lectures restent
#                                   intactes. Sans lui, l'échec de publication n'est
#                                   exerçable qu'avec « echec », qui fait tomber les
#                                   lectures d'abord : le script n'arrive alors
#                                   jamais jusqu'à sa branche de publication.
#
#   GH_STUB_PERMISSION          Permission renvoyée par
#                               `gh api repos/…/collaborators/<login>/permission`.
#                               Défaut : « admin ». Mettre « read » ou « triage »
#                               pour exercer le refus de l'étage 2.
#
#   GH_STUB_PERMISSIONS_PAR_LOGIN
#                               Table « login=permission », séparée par des
#                               virgules : « alice=admin,mallory=read ». Un login
#                               absent de la table garde GH_STUB_PERMISSION, donc
#                               aucun appel existant ne change de comportement.
#                               La valeur spéciale « 404 » fait répondre « Not
#                               Found » pour ce login seul.
#                               Sans cette table, l'étage 2 bis du lot 2 n'est
#                               exerçable qu'avec un 404, et remplacer
#                               `!permissionSuffisante(permissionAuteur)` par
#                               `permissionAuteur === null` reste vert : un auteur
#                               d'issue réellement en « read » passerait pour
#                               digne de confiance.
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
#   GH_STUB_COPIE_CORPS         Répertoire où le CONTENU de tout « --body-file »
#                               est recopié, sous le nom « corps-<numéro
#                               d'appel>.md ». Sans cette copie, rien ne peut
#                               vérifier ce qui aurait été publié : `resolve.js`
#                               écrit le corps dans un temporaire qu'il supprime
#                               dès le retour de l'appel (`avecFichierCorps`). Le
#                               numéro d'appel est celui du journal, ce qui permet
#                               d'apparier un corps et son argv.
#
#   GH_STUB_PR_LIST             Réponse de `pr list`, INDÉPENDAMMENT du scénario —
#                               et prioritaire sur lui. Valeurs :
#                                 aucune  -> []                (chemin « pas de PR »)
#                                 pr      -> [{"number":<GH_STUB_NUMERO_PR>}]
#                                 echec   -> sort en GH_STUB_CODE_SORTIE
#                                 plusieurs-pr
#                                         -> [{"number":4},{"number":12},{"number":7}]
#                                   PLUSIEURS pull requests pour la même branche : le
#                                   compte rendu doit viser la plus récente, donc le
#                                   plus GRAND numéro. Avec une seule PR servie,
#                                   remplacer `Math.max` par `Math.min` dans
#                                   `numeroPrDeLaBranche` restait vert. Trois entrées
#                                   et non deux, dans cet ordre exprès : 12 n'est ni
#                                   la première (4) ni la dernière (7) ni la plus
#                                   petite, donc « prendre la première », « prendre la
#                                   dernière » et `Math.min` rougissent tous les trois.
#                                 objet   -> {"number":12}
#                                   Réponse BIEN FORMÉE en JSON mais qui n'est pas la
#                                   liste attendue. Ce n'est pas « cette branche n'a
#                                   pas de PR » : le repli sur l'issue doit s'annoncer.
#                                 numero-chaine
#                                         -> [{"number":"12"}]
#                                   Même famille : la liste est là, le champ `number`
#                                   n'est pas un entier. `Number.isInteger("12")` est
#                                   faux, donc aucun numéro n'en sort, et le silence
#                                   serait de nouveau un silence.
#                               Vide (défaut) = le scénario décide, donc aucun appel
#                               existant ne change de comportement. Elle existe pour
#                               `test/compte-rendu.test.js`, qui doit choisir la
#                               CIBLE (pull request ou issue) sans emprunter un
#                               scénario dont le nom parle d'autre chose.
#
#   GH_STUB_COMMENTAIRES        Réponse de `pr view <n> --json comments` et de
#                               `issue view <n> --json comments`. Liste de jetons
#                               séparés par des virgules, un jeton = un commentaire,
#                               dans l'ordre :
#                                 tiers            un commentaire humain, sans marqueur
#                                 marqueur-nu      un compte rendu portant le marqueur
#                                                  NU, celui d'un run local ou d'un
#                                                  run antérieur à la portée
#                                 marqueur-portee  un compte rendu portant
#                                                  « run=<GH_STUB_PORTEE_MARQUEUR> »
#                                 libre            GH_STUB_CORPS_COMMENTAIRE, tel quel
#                               Deux valeurs ne sont PAS des listes :
#                                 aucun (défaut)   {"comments":[]}
#                                 json-invalide    une URL, donc du non-JSON : c'est
#                                                  ce que répondait ce stub avant, et
#                                                  ça reste une dégradation à exercer
#                                 sans-champ       {} — un objet sans « comments »
#                               Un jeton inconnu fait sortir le stub en 64 : une
#                               faute de frappe dans un test ne doit pas se lire
#                               « aucun commentaire », ce qui rendrait le test vert
#                               pour la mauvaise raison.
#
#   GH_STUB_COMMENTAIRES_ISSUE  Même format que GH_STUB_COMMENTAIRES, mais pour
#                               `issue view <n> --json comments` SEULEMENT. Absente
#                               (défaut), la réponse de l'issue reste celle de
#                               GH_STUB_COMMENTAIRES : aucun appel existant ne change
#                               de comportement.
#                               Sans ce bouton, les commentaires de la pull request et
#                               ceux de l'issue sont les MÊMES, et le doublon que
#                               `rendre-compte.js` doit éviter n'est pas exprimable :
#                               une PR fermée d'un run antérieur portant le marqueur
#                               d'une autre portée, et le compte rendu de CE run sur
#                               l'issue.
#
#   GH_STUB_PORTEE_MARQUEUR     Portée écrite dans le jeton « marqueur-portee ».
#                               Défaut : « 111-1 », donc un AUTRE run que celui du
#                               test, par défaut.
#
#   GH_STUB_CORPS_COMMENTAIRE   Corps du jeton « libre ». Échappé pour JSON par le
#                               stub : guillemets, contre-obliques et retours à la
#                               ligne passent.
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

# Numéro de cet appel = nombre de séparateurs d'enregistrement dans le journal.
appel="$(tr -cd '\036' <"$journal" | wc -c | tr -d ' ')"

printf 'gh-stub: appel %s : %s\n' "$appel" "$*" >&2

# Copie du corps passé en « --body-file », avant que resolve.js ne supprime son
# temporaire.
if [ -n "${GH_STUB_COPIE_CORPS:-}" ]; then
  mkdir -p "$GH_STUB_COPIE_CORPS" 2>/dev/null || true
  precedent=""
  for arg in "$@"; do
    if [ "$precedent" = "--body-file" ] && [ -f "$arg" ]; then
      cp "$arg" "$GH_STUB_COPIE_CORPS/corps-$appel.md"
    fi
    precedent="$arg"
  done
fi

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

# --- lecture des commentaires -------------------------------------------------
#
# `pr view` / `issue view --json comments` est la seule lecture de
# `scripts/rendre-compte.js`. Le reste du dépôt ne l'appelle nulle part (relevé :
# un seul appel, `scripts/rendre-compte.js:425`), mais `pr view` SANS
# « --json comments » gardait un comportement — une URL — dont on ne touche pas :
# d'où le drapeau ci-dessous plutôt qu'une branche attrape-tout.

veut_commentaires=0
precedent=""
for arg in "$@"; do
  if [ "$precedent" = "--json" ]; then
    case "$arg" in *comments*) veut_commentaires=1 ;; esac
  fi
  precedent="$arg"
done

# Échappe pour une chaîne JSON : contre-obliques, guillemets, retours à la ligne.
# Sans ça, un corps de commentaire piloté par un test casserait le JSON du stub et
# le script sous test dégraderait — le test passerait au vert en croyant exercer
# l'idempotence.
echapper_json() {
  printf '%s' "$1" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    | awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }'
}

# Un corps de compte rendu plausible, terminé par le marqueur qu'on lui passe.
# La forme est celle de `publierCompteRendu` : la phrase d'échec, une ligne vide,
# le marqueur en dernier.
corps_compte_rendu() {
  printf '%s\n\n%s' \
    'Echec apres 2 iteration(s). Cause : la validation ne passe pas.' "$1"
}

# $1 = l'entité consultée, « pr » ou « issue ». Elle est passée en argument parce que
# les deux côtés doivent pouvoir répondre DIFFÉREMMENT : `rendre-compte.js` cherche le
# marqueur sur la pull request puis sur l'issue, et le doublon qu'il doit éviter n'est
# exprimable qu'avec deux réponses distinctes.
emettre_commentaires() {
  entite="${1:-}"
  liste="${GH_STUB_COMMENTAIRES:-aucun}"

  # GH_STUB_COMMENTAIRES_ISSUE ne vaut que pour l'issue, et seulement si elle est
  # renseignée : absente, la réponse de l'issue reste celle de GH_STUB_COMMENTAIRES,
  # donc aucun appel existant ne change de comportement.
  if [ "$entite" = "issue" ] && [ -n "${GH_STUB_COMMENTAIRES_ISSUE:-}" ]; then
    liste="$GH_STUB_COMMENTAIRES_ISSUE"
  fi

  case "$liste" in
    json-invalide)
      # Ce que ce stub répondait à `pr view` avant l'ajout des commentaires : du
      # non-JSON. `lib/gh.js` lève, et `rendre-compte.js` publie sans avoir pu
      # contrôler le doublon. Conservé comme scénario à part entière.
      printf 'https://github.com/%s/pull/%s\n' "$depot" "$numero_pr"
      return 0
      ;;
    sans-champ)
      printf '{}\n'
      return 0
      ;;
  esac

  marqueur_nu='<!-- deepseek-resolve:compte-rendu -->'
  marqueur_porte="<!-- deepseek-resolve:compte-rendu run=${GH_STUB_PORTEE_MARQUEUR:-111-1} -->"

  sortie='{"comments":['
  premier=1
  ancien_ifs="$IFS"
  IFS=','
  for jeton in $liste; do
    case "$jeton" in
      aucun|'') continue ;;
      tiers) corps='Merci, je regarde ca ce soir.' ;;
      marqueur-nu) corps="$(corps_compte_rendu "$marqueur_nu")" ;;
      marqueur-portee) corps="$(corps_compte_rendu "$marqueur_porte")" ;;
      libre) corps="${GH_STUB_CORPS_COMMENTAIRE:-}" ;;
      *)
        printf 'gh-stub: jeton GH_STUB_COMMENTAIRES inconnu : %s\n' "$jeton" >&2
        exit 64
        ;;
    esac
    [ "$premier" = "1" ] || sortie="$sortie,"
    premier=0
    sortie="$sortie{\"body\":\"$(echapper_json "$corps")\"}"
  done
  IFS="$ancien_ifs"

  printf '%s]}\n' "$sortie"
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

  # Table par login. Elle l'emporte sur GH_STUB_PERMISSION pour les logins
  # qu'elle nomme, et ne touche à rien pour les autres.
  table="${GH_STUB_PERMISSIONS_PAR_LOGIN:-}"
  if [ -n "$table" ]; then
    ancien_ifs="$IFS"
    IFS=','
    for paire in $table; do
      cle="${paire%%=*}"
      valeur="${paire#*=}"
      [ "$cle" = "$login" ] && permission="$valeur"
    done
    IFS="$ancien_ifs"
  fi

  # « 404 » n'est pas une permission : c'est un compte que l'API déclare inconnu.
  # Permet de mélanger, dans une même table, un collaborateur et un non-collaborateur.
  [ "$permission" = "404" ] && repondre_404

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
    # Réponse pilotée à la main, prioritaire sur le scénario : le lot 4 doit
    # choisir la cible (pull request ou issue) sans emprunter un scénario dont le
    # nom parle d'autorisation.
    if [ -n "${GH_STUB_PR_LIST:-}" ]; then
      case "$GH_STUB_PR_LIST" in
        aucune) printf '[]\n' ;;
        pr) printf '[{"number":%s}]\n' "$numero_pr" ;;
        plusieurs-pr) printf '[{"number":4},{"number":12},{"number":7}]\n' ;;
        objet) printf '{"number":12}\n' ;;
        numero-chaine) printf '[{"number":"12"}]\n' ;;
        echec)
          printf 'gh-stub: « pr list » en échec simulé (GH_STUB_PR_LIST=echec)\n' >&2
          exit "${GH_STUB_CODE_SORTIE:-1}"
          ;;
        *)
          printf 'gh-stub: GH_STUB_PR_LIST inconnu : %s\n' "$GH_STUB_PR_LIST" >&2
          exit 64
          ;;
      esac
      exit 0
    fi
    # Échec ISOLÉ : la permission a déjà répondu plus haut, seul ce contrôle-ci
    # tombe. C'est le seul moyen d'atteindre la branche « état indéterminé » de
    # l'étape 7 du lot 2.
    if [ "$scenario" = "echec-pr-list" ]; then
      printf 'gh-stub: « pr list » en échec simulé (scénario « echec-pr-list »)\n' >&2
      exit "${GH_STUB_CODE_SORTIE:-1}"
    fi
    if [ "$scenario" = "pr-ouverte" ] || [ "$scenario" = "pr-existe-deja" ]; then
      printf '[{"number":%s,"url":"https://github.com/%s/pull/%s","state":"OPEN"}]\n' \
        "$numero_pr" "$depot" "$numero_pr"
    else
      printf '[]\n'
    fi
    ;;
  "pr create")
    if [ "$scenario" = "pr-existe-deja" ]; then
      printf 'a pull request for branch "%s" into branch "main" already exists\n' \
        "${3:-inconnue}" >&2
      exit 1
    fi
    printf 'https://github.com/%s/pull/%s\n' "$depot" "$numero_pr"
    ;;
  "pr view"|"issue view")
    if [ "$veut_commentaires" = "1" ]; then
      if [ "$scenario" = "echec-view" ]; then
        printf 'gh-stub: lecture des commentaires en échec simulé (« echec-view »)\n' >&2
        exit "${GH_STUB_CODE_SORTIE:-1}"
      fi
      emettre_commentaires "${1:-}"
    elif [ "${2:-}" = "view" ] && [ "${1:-}" = "pr" ]; then
      # Comportement d'avant : `gh` écrit l'URL de l'objet consulté.
      printf 'https://github.com/%s/pull/%s\n' "$depot" "$numero_pr"
    else
      # `issue view` tombait dans le cas attrape-tout, qui écrit « [] ».
      printf '[]\n'
    fi
    ;;
  "pr comment"|"issue comment")
    if [ "$scenario" = "echec-commentaire" ]; then
      printf 'gh-stub: publication en échec simulé (« echec-commentaire »)\n' >&2
      exit "${GH_STUB_CODE_SORTIE:-1}"
    fi
    # `gh` écrit l'URL de l'objet créé : c'est là que resolve.js lit le numéro de PR.
    printf 'https://github.com/%s/pull/%s\n' "$depot" "$numero_pr"
    ;;
  *)
    printf '[]\n'
    ;;
esac

exit 0
