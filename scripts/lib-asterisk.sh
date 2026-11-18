#!/usr/bin/env bash
#
# Shared Asterisk checks for install.sh and install-asterisk-source.sh.
#
# Everything here exists because of a failure that was expensive to diagnose
# once. Sourced, not executed; the caller provides say/warn/die.

# Packages disagree about where modules live (/usr/lib, /usr/lib64, the
# multiarch dir), so ask Asterisk instead of guessing and then reporting
# "nothing there" because we looked in the wrong directory.
ast_module_dir() {
  local d
  d=$(asterisk -rx "core show settings" 2>/dev/null \
      | sed -n 's/.*[Mm]odule directory: *//p' | head -1)
  [ -n "$d" ] && [ -d "$d" ] && { echo "$d"; return; }
  for d in /usr/lib/asterisk/modules /usr/lib64/asterisk/modules \
           /usr/lib/x86_64-linux-gnu/asterisk/modules; do
    [ -d "$d" ] && { echo "$d"; return; }
  done
  echo "(module directory not found)"
}

# Is ARI usable -- not "is something named res_ari* loaded". res_ari_model.so
# ships and loads by itself on builds with no ARI at all, so a `module show
# like res_ari` grep reports success on a box that cannot place a single call.
# Name the two modules that actually matter.
ari_modules_ok() {
  asterisk -rx "module show like ari" 2>/dev/null \
    | grep -qE '^res_ari\.so[[:space:]].*Running' || return 1
  asterisk -rx "module show like stasis" 2>/dev/null \
    | grep -qE '^res_stasis\.so[[:space:]].*Running' || return 1
}

pjsip_modules_ok() {
  asterisk -rx "module show like pjsip" 2>/dev/null \
    | grep -qE '^chan_pjsip\.so[[:space:]].*Running'
}

ari_missing_report() {
  warn "ARI is not usable on this Asterisk. Loaded:"
  asterisk -rx "module show like ari" 2>/dev/null | sed 's/^/      /' || true
  warn "In $(ast_module_dir):"
  ls "$(ast_module_dir)" 2>/dev/null | grep -E 'res_ari|res_stasis' | sed 's/^/      /' \
    || echo "      (none)"
}

pjsip_missing_report() {
  warn "PJSIP did not load. Asterisk's logged reason:"
  grep -ih 'undefined symbol\|res_pjsip' /var/log/asterisk/messages*.log 2>/dev/null \
    | tail -3 | sed 's/^/      /' || true
  warn "pjproject libraries visible to the linker:"
  ldconfig -p 2>/dev/null | grep -i libasteriskpj | sed 's/^/      /' || echo "      (none)"
}

# A distro Asterisk package installs libasteriskpj.so.2 into the multiarch
# directory, which the linker searches before /usr/lib. After a source build
# the new PJSIP modules then resolve against the OLDER library and every one of
# them dies with "undefined symbol: pjsip_endpt_send_request2" -- while ldd
# reports nothing missing, because the library is found, just out of date.
# Move the shadowing copies aside rather than deleting: if this diagnosis is
# wrong, they go straight back.
fix_shadowed_pjproject() {
  local keep="${1:-/usr/lib/libasteriskpj.so.2}"
  [ -e "$keep" ] || return 0
  local stash="${SHADOWPBX_LIB_STASH:-/root/shadowpbx-shadowed-libs}" moved=0 p
  while read -r p; do
    [ -n "$p" ] && [ -e "$p" ] || continue
    [ "$(readlink -f "$p")" = "$(readlink -f "$keep")" ] && continue
    mkdir -p "$stash"
    warn "moving $p aside — it shadows the freshly built $keep"
    mv "$p" "$stash/$(basename "$p").$(date +%s)" && moved=1
  done < <(ldconfig -p 2>/dev/null | awk '/libasteriskpj\.so/ {print $NF}' | sort -u)
  if [ "$moved" = 1 ]; then
    ldconfig
    echo "    originals kept in $stash — delete once calls are working"
  fi
}

# An `apt upgrade` that touches the distro asterisk packages puts that old
# pjproject library back and breaks PJSIP again, with nothing to connect the
# breakage to the upgrade. Pin them to the source build instead.
hold_distro_asterisk() {
  command -v apt-mark >/dev/null 2>&1 || return 0
  local pkgs
  pkgs=$(dpkg-query -W -f='${Package}\n' 'asterisk*' 2>/dev/null | grep -v 'sounds' || true)
  [ -n "$pkgs" ] || return 0
  # shellcheck disable=SC2086
  apt-mark hold $pkgs >/dev/null 2>&1 \
    && echo "    held so apt cannot restore them: $(echo $pkgs | tr '\n' ' ')"
}
