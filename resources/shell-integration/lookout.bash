# Adapted from VS Code shellIntegration-bash.sh (Microsoft Corporation, MIT license).
# https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh
[[ ${__lookout_installed:-} == 1 ]] && return
__lookout_installed=1

# --init-file replaces .bashrc. Reproduce login startup explicitly because Bash
# ignores --init-file when --login is present. A manually sourced copy skips this.
if [[ ${LOOKOUT_SHELL_INTEGRATION:-} == 1 ]]; then
  if [[ ${LOOKOUT_SHELL_LOGIN:-} == 1 ]]; then
    [[ -r /etc/profile ]] && . /etc/profile
    if [[ -r ~/.bash_profile ]]; then
      . ~/.bash_profile
    elif [[ -r ~/.bash_login ]]; then
      . ~/.bash_login
    elif [[ -r ~/.profile ]]; then
      . ~/.profile
    fi
  elif [[ -r ~/.bashrc ]]; then
    . ~/.bashrc
  fi
fi
unset LOOKOUT_SHELL_LOGIN
__lookout_nonce=${LOOKOUT_NONCE:-}
unset LOOKOUT_NONCE

__lookout_escape() {
  local LC_ALL=C value=$1 result='' char token number i
  for ((i = 0; i < ${#value}; i++)); do
    char=${value:i:1}
    printf -v number '%d' "'$char"
    if ((number < 32)); then
      printf -v token '\\x%02x' "$number"
    elif [[ $char == '\' ]]; then
      token='\\'
    elif [[ $char == ';' ]]; then
      token='\x3b'
    else
      token=$char
    fi
    result+=$token
  done
  printf '%s' "$result"
}

__lookout_emit_command() {
  printf '\e]633;E;%s;%s\a\e]633;C\a' "$(__lookout_escape "$1")" "$__lookout_nonce"
}

__lookout_restore_status() { return "$1"; }

__lookout_in_command=1
__lookout_prompt_seen=0
__lookout_command=''
__lookout_wrapped_ps1=''
__lookout_original_prompt_command=("${PROMPT_COMMAND[@]}")
# Parse the shell-quoted trap output, preserving quotes and multiline trap bodies.
__lookout_trap_parts=()
eval "__lookout_trap_parts=( $(trap -p DEBUG) )"
__lookout_original_debug=${__lookout_trap_parts[2]:-}
unset __lookout_trap_parts

__lookout_debug() {
  local status=$1 command=$2 history_line
  if [[ $__lookout_in_command == 0 && $command != __lookout_prompt* ]]; then
    __lookout_in_command=1
    # History retains compound commands and unexpanded aliases. Fall back to
    # BASH_COMMAND when history is disabled/ignorespace suppresses this entry.
    __lookout_command=$command
    history_line=$(HISTTIMEFORMAT= builtin history 1)
    if [[ $history_line =~ ^[[:space:]]*([0-9]+)[[:space:]]+(.*)$ && ${BASH_REMATCH[1]} != "$__lookout_history_id" ]]; then
      __lookout_command=${BASH_REMATCH[2]}
    fi
    __lookout_emit_command "$__lookout_command"
  fi
  return "$status"
}

__lookout_prompt() {
  local status=$? command cwd history_line
  __lookout_in_command=1
  if [[ $__lookout_prompt_seen == 1 ]]; then
    if [[ -n $__lookout_command ]]; then
      printf '\e]633;D;%s\a' "$status"
    else
      printf '\e]633;D\a'
    fi
  fi
  # Preserve all original PROMPT_COMMAND entries, including their incoming $?.
  __lookout_restore_status "$status"
  for command in "${__lookout_original_prompt_command[@]}"; do
    eval "$command"
  done
  cwd=$PWD
  if command -v cygpath >/dev/null 2>&1; then cwd=$(cygpath -m "$PWD"); fi
  printf '\e]633;P;Cwd=%s\a' "$(__lookout_escape "$cwd")"
  if [[ ${PS1:-} != "$__lookout_wrapped_ps1" ]]; then
    __lookout_wrapped_ps1='\[\e]633;A\a\]'${PS1:-}'\[\e]633;B\a\]'
    PS1=$__lookout_wrapped_ps1
  fi
  history_line=$(HISTTIMEFORMAT= builtin history 1)
  __lookout_history_id=''
  if [[ $history_line =~ ^[[:space:]]*([0-9]+) ]]; then __lookout_history_id=${BASH_REMATCH[1]}; fi
  __lookout_command=''
  __lookout_prompt_seen=1
  __lookout_in_command=0
  return "$status"
}

# Array assignment also removes any old entries after index zero.
PROMPT_COMMAND=(__lookout_prompt)
# The original DEBUG body still runs for every event; no trap is discarded.
trap '__lookout_debug "$?" "$BASH_COMMAND"; eval "$__lookout_original_debug"' DEBUG

if [[ -n ${LOOKOUT_STARTUP_COMMAND:-} ]]; then
  __lookout_startup=$LOOKOUT_STARTUP_COMMAND
  unset LOOKOUT_STARTUP_COMMAND
  __lookout_command=$__lookout_startup
  __lookout_prompt_seen=1
  printf '\e]633;A\a\e]633;B\a'
  __lookout_emit_command "$__lookout_startup"
  eval "$__lookout_startup"
fi
