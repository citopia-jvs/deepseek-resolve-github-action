#!/usr/bin/env bash
#
# aider-stub.sh — faux binaire `aider`, injecté par la variable AIDER_CLI.
#
# C'est ce stub qui rend les lots 3b et 3c vérifiables sans clé DeepSeek et sans
# réseau. Comportement par défaut : il écrit un fichier connu dans le dépôt
# courant (le répertoire de travail, comme le vrai aider), journalise son argv
# dans un fichier, et sort en 0.
#
# Il n'écrit jamais rien en dehors du répertoire de travail, sauf son journal.
#
# ─── Variables de scénario ────────────────────────────────────────────────────
#
#   AIDER_STUB_SCENARIO   Scénario. Valeurs reconnues :
#
#     nominal (défaut)   Ajoute une ligne à AIDER_STUB_FICHIER. Un appel = une
#                        modification, donc un commit possible à chaque tour de
#                        boucle (indispensable au test MAX_ITERATIONS=2 : sans
#                        cela, le deuxième tour ne produirait aucun diff).
#
#     rien               N'écrit aucun fichier, sort en 0. C'est le chemin R4 :
#                        aucune modification proposée -> aucune PR, code 0.
#
#     echec              N'écrit rien, écrit un message d'erreur sur stderr et
#                        sort en AIDER_STUB_CODE_SORTIE (défaut 1). Simule une
#                        clé refusée (401), un crédit épuisé (402) ou un
#                        plantage Python -> arrêt immédiat, échec technique.
#
#     workflow           Écrit AIDER_STUB_FICHIER (autorisé) ET
#                        « .github/workflows/ci.yml » (interdit). R3 : le chemin
#                        interdit doit être refusé et absent de
#                        `git log --name-only`, tandis que le fichier autorisé
#                        est bien commité.
#
#     conf-aider         Écrit AIDER_STUB_FICHIER (autorisé) ET
#                        « .aider.conf.yml » (interdit). R8 : une configuration
#                        déposée au tour 1 serait chargée au tour 2.
#
#     auto-commit        Écrit AIDER_STUB_FICHIER (autorisé) puis écrit ET COMMITE
#                        lui-même AIDER_STUB_FICHIER_AUTO_COMMIT (défaut
#                        « .github/workflows/ci.yml »). Le vrai aider commite par
#                        défaut ; `--no-auto-commits` le désactive, mais un
#                        `.aider.conf.yml` SUIVI par le dépôt consommateur peut le
#                        réactiver — R8 documente que les flags ne ferment pas
#                        toute la découverte de configuration. Un chemin interdit
#                        entre alors dans la branche SANS passer par
#                        `commiterTravail` : c'est le seul moyen d'atteindre le
#                        contrôle de ceinture du lot 3c, et de vérifier qu'il est
#                        refait avant CHAQUE push et pas seulement le premier.
#
#     interdits-seuls    Écrit uniquement « .github/workflows/ci.yml » et
#                        « .aider.conf.yml », rien d'autorisé. Tout est refusé,
#                        donc aucun commit : R3 + R8 croisés avec R4.
#
#   AIDER_STUB_SCENARIOS     Scénarios PAR APPEL, séparés par des virgules :
#                            « nominal,rien » fait écrire le premier appel et rien
#                            au second. L'appel n prend le n-ième élément ; au-delà
#                            du dernier, le dernier est réutilisé. Vide (défaut) :
#                            AIDER_STUB_SCENARIO s'applique à tous les appels.
#                            Raison d'être : la troisième formulation d'échec du
#                            compte rendu (0 < iterations < maxIterations) n'est
#                            atteignable que par un tour de correction qui ne
#                            produit AUCUN commit, donc par un stub qui change de
#                            comportement d'un appel à l'autre. Sans cela, cette
#                            branche de `publierCompteRendu` n'a aucun test et la
#                            phrase gelée peut la manger sans que rien ne rougisse.
#
#   AIDER_STUB_FICHIER       Chemin du fichier autorisé écrit par les scénarios
#                            nominal / workflow / conf-aider, relatif au
#                            répertoire de travail. Défaut :
#                            « resultat-aider.txt ».
#
#   AIDER_STUB_CHEMINS_SUPP  Chemins supplémentaires à écrire, séparés par des
#                            espaces. Permet d'exercer un chemin interdit de la
#                            liste du lot 3b sans ajouter de scénario.
#
#   AIDER_STUB_RENOMMER      Couple « source destination » passé à « git mv ».
#                            Un renommage a DEUX côtés, et git les rend sur deux
#                            entrées consécutives : c'est le seul moyen d'exercer
#                            la règle du contrat « si l'un des deux côtés est
#                            interdit, les deux sont refusés ». Commiter la moitié
#                            d'un renommage laisserait un dépôt incohérent.
#
#   AIDER_STUB_STAGE         Chemins à « git add » après écriture, séparés par des
#                            espaces. Le vrai aider STAGE les fichiers qu'il
#                            édite (`repo.py`), même avec `--no-auto-commits` :
#                            sans ce scénario, l'étape « vider l'index » de
#                            `commiterTravail` n'a aucun test, et la retirer
#                            laisserait un chemin interdit déjà stagé entrer dans
#                            le commit — `git checkout --` reprend le contenu de
#                            l'INDEX, pas celui de HEAD.
#
#   AIDER_STUB_SORTIE        Texte écrit sur stdout à la place de la sortie par
#                            défaut. Sert à faire remonter un motif dans le
#                            compte rendu (« rien à faire », par exemple).
#
#   AIDER_STUB_CODE_SORTIE   Code de sortie du scénario « echec ». Défaut : 1.
#
#   AIDER_STUB_JOURNAL       Fichier où l'argv de chaque appel est journalisé.
#                            Défaut : "${TMPDIR:-/tmp}/aider-stub-journal".
#                            Volontairement hors du dépôt : un journal écrit
#                            dans le répertoire de travail polluerait
#                            `git status` et fausserait les tests de commit.
#                            Chaque test doit en fixer un qui lui est propre.
#
#   AIDER_STUB_JOURNAL_ENV   Fichier où l'ENVIRONNEMENT REÇU est écrit, une
#                            variable par ligne, trié. C'est le seul moyen de
#                            vérifier R7 côté aider (« il ne reçoit jamais
#                            GH_TOKEN ») et la liste blanche
#                            d'`environnementAider()` : une liste noire laisserait
#                            passer GITHUB_* et les variables du harnais. Écrasé
#                            à chaque appel, donc il décrit le DERNIER appel.
#
#   AIDER_STUB_JOURNAL_VU    Fichier où le stub note, en AJOUT, les cibles de
#                            découverte d'aider visibles dans le répertoire de
#                            travail AU MOMENT de l'appel : « .aider.conf.yml »,
#                            « .aider.model.metadata.json » et « .env ». Sans
#                            cela, la neutralisation R8 de `appelerAider` n'est
#                            observable qu'après coup, et un `.env` supprimé puis
#                            réécrit passerait pour un `.env` jamais vu.
#
#   AIDER_STUB_ATTENTE       Nombre de secondes de sommeil avant d'écrire quoi que
#                            ce soit. Sert à dépasser la borne de durée
#                            (MINUTES_MAX_APPEL_AIDER) : le stub est alors tué par
#                            SIGTERM et `appelerAider` doit rendre 124. Le journal
#                            d'argv est écrit AVANT le sommeil, pour que l'appel
#                            interrompu reste comptabilisé.
#
# Tous les chemins écrits le sont en AJOUT (>>). Si le fichier est déjà suivi
# par git, l'appel produit une modification ; sinon, une création. Les deux
# branches de restauration du lot 3b (`git checkout --` pour un suivi modifié,
# suppression pour un non-suivi créé) sont donc atteignables avec le même stub,
# selon ce que le dépôt jetable du test contient déjà.
#
# ─── Format du journal ────────────────────────────────────────────────────────
#
# Un appel = les arguments séparés par un octet NUL (\0), suivis d'un octet
# « record separator » (\036). Ni échappement ni guillemets : la consigne passée
# en `--message`, qui contient des retours à la ligne, est restituée telle
# quelle — c'est ce qui permet de vérifier R6 (le bloc <!-- … --> doit être
# absent du prompt construit). Lecture côté Node :
#
#   const appels = fs.readFileSync(journal, 'utf8')
#     .split('\x1e').filter(Boolean)
#     .map(r => r.split('\0').filter(s => s !== ''));
#   const consigne = appels[0][appels[0].indexOf('--message') + 1];
#
# `appels.length` est le nombre d'appels à aider : c'est le compteur du test
# MAX_ITERATIONS=2. Un résumé lisible part aussi sur stderr.

set -uo pipefail

journal="${AIDER_STUB_JOURNAL:-${TMPDIR:-/tmp}/aider-stub-journal}"
mkdir -p "$(dirname "$journal")" 2>/dev/null || true
{ printf '%s\0' "$@"; printf '\036'; } >>"$journal"

# Numéro de cet appel = nombre de séparateurs d'enregistrement dans le journal.
appel="$(tr -cd '\036' <"$journal" | wc -c | tr -d ' ')"

printf 'aider-stub: appel %s dans %s : %s\n' "$appel" "$PWD" "$*" >&2

# Liste des variables de pilotage effectivement reçues. Elle part sur stderr,
# donc dans la « sortie » que `appelerAider` renvoie : c'est ce qui rend
# observable la trappe de test d'`environnementAider()` — sans AIDER_CLI, cette
# liste doit être VIDE, y compris si le harnais a posé les variables.
printf 'aider-stub: variables AIDER_STUB_* reçues : [%s]\n' "${!AIDER_STUB_*}" >&2

if [ -n "${AIDER_STUB_JOURNAL_ENV:-}" ]; then
  mkdir -p "$(dirname "$AIDER_STUB_JOURNAL_ENV")" 2>/dev/null || true
  env | sort >"$AIDER_STUB_JOURNAL_ENV"
fi

# Ce que le stub VOIT du dépôt : les trois cibles de découverte d'aider (R8).
if [ -n "${AIDER_STUB_JOURNAL_VU:-}" ]; then
  mkdir -p "$(dirname "$AIDER_STUB_JOURNAL_VU")" 2>/dev/null || true
  for cible in .aider.conf.yml .aider.model.metadata.json .env; do
    if [ -e "$cible" ]; then
      printf 'appel %s voit %s\n' "$appel" "$cible" >>"$AIDER_STUB_JOURNAL_VU"
    fi
  done
fi

# Sommeil AVANT toute écriture : le stub doit être tué par la borne de durée sans
# avoir rien produit.
if [ -n "${AIDER_STUB_ATTENTE:-}" ]; then
  printf 'aider-stub: sommeil de %s seconde(s) (borne de durée)\n' "$AIDER_STUB_ATTENTE" >&2
  sleep "$AIDER_STUB_ATTENTE"
fi

scenario="${AIDER_STUB_SCENARIO:-nominal}"
fichier="${AIDER_STUB_FICHIER:-resultat-aider.txt}"

# Scénario propre à CET appel, s'il y a une liste. Le dernier élément couvre tous
# les appels suivants : « nominal,rien » sur quatre appels donne
# nominal, rien, rien, rien.
if [ -n "${AIDER_STUB_SCENARIOS:-}" ]; then
  ancien_ifs="$IFS"
  IFS=','
  indice=0
  for scenario_de_l_appel in ${AIDER_STUB_SCENARIOS}; do
    indice=$((indice + 1))
    scenario="$scenario_de_l_appel"
    [ "$indice" -ge "$appel" ] && break
  done
  IFS="$ancien_ifs"
  printf 'aider-stub: scénario de l’appel %s : %s\n' "$appel" "$scenario" >&2
fi

ecrire() {
  chemin="$1"
  repertoire="$(dirname "$chemin")"
  [ "$repertoire" != "." ] && mkdir -p "$repertoire"
  printf '# écrit par aider-stub.sh, appel %s\n' "$appel" >>"$chemin"
  printf 'aider-stub: écrit %s\n' "$chemin" >&2
}

if [ "$scenario" = "echec" ]; then
  printf 'aider-stub: échec simulé (scénario « echec »)\n' >&2
  printf "litellm.AuthenticationError: AuthenticationError: DeepSeekException - Error code: 401\n" >&2
  exit "${AIDER_STUB_CODE_SORTIE:-1}"
fi

case "$scenario" in
  rien)
    : # aucun fichier écrit — chemin R4
    ;;
  nominal)
    ecrire "$fichier"
    ;;
  workflow)
    ecrire "$fichier"
    ecrire ".github/workflows/ci.yml"
    ;;
  conf-aider)
    ecrire "$fichier"
    ecrire ".aider.conf.yml"
    ;;
  interdits-seuls)
    ecrire ".github/workflows/ci.yml"
    ecrire ".aider.conf.yml"
    ;;
  auto-commit)
    ecrire "$fichier"
    auto_commite="${AIDER_STUB_FICHIER_AUTO_COMMIT:-.github/workflows/ci.yml}"
    ecrire "$auto_commite"
    # Identité passée en `-c` : le stub ne dépend pas de celle du dépôt, et il
    # n'écrit aucune configuration.
    if git add -- "$auto_commite" &&
      git -c user.name=aider-stub -c user.email=aider-stub@exemple.invalide \
        commit --quiet --no-verify -m "aider-stub: auto-commit de $auto_commite"; then
      printf 'aider-stub: auto-commité %s\n' "$auto_commite" >&2
    else
      printf 'aider-stub: auto-commit de %s a échoué\n' "$auto_commite" >&2
    fi
    ;;
  *)
    printf 'aider-stub: scénario inconnu « %s »\n' "$scenario" >&2
    exit 2
    ;;
esac

for chemin_supp in ${AIDER_STUB_CHEMINS_SUPP:-}; do
  ecrire "$chemin_supp"
done

# Renommage, comme un « /rename » suivi d'une édition. « git mv » stage les deux
# côtés : le statut vu par etatFichiers() est bien « R  ».
if [ -n "${AIDER_STUB_RENOMMER:-}" ]; then
  renommer_source="${AIDER_STUB_RENOMMER%% *}"
  renommer_cible="${AIDER_STUB_RENOMMER##* }"
  if git mv -- "$renommer_source" "$renommer_cible" 2>/dev/null; then
    printf 'aider-stub: renommé %s -> %s\n' "$renommer_source" "$renommer_cible" >&2
  else
    printf 'aider-stub: « git mv -- %s %s » a échoué\n' "$renommer_source" "$renommer_cible" >&2
  fi
fi

# Comme le vrai aider : les fichiers édités sont stagés, même sans auto-commit.
for chemin_stage in ${AIDER_STUB_STAGE:-}; do
  if git add -- "$chemin_stage" 2>/dev/null; then
    printf 'aider-stub: stagé %s\n' "$chemin_stage" >&2
  else
    printf 'aider-stub: « git add -- %s » a échoué\n' "$chemin_stage" >&2
  fi
done

if [ -n "${AIDER_STUB_SORTIE:-}" ]; then
  printf '%s\n' "$AIDER_STUB_SORTIE"
else
  printf 'Aider v0.86.2 (aider-stub)\n'
  if [ "$scenario" = "rien" ]; then
    printf "Aucune modification nécessaire : le dépôt est déjà conforme.\n"
  else
    printf 'Applied edit (appel %s)\n' "$appel"
  fi
fi

exit 0
