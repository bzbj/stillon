/* Keep a stable launchd responsibility owner while the controller runs. */
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static void child_changed(int signal_number) { (void)signal_number; }

int main(int argc, char **argv) {
    if (argc < 2 || argv[1][0] != '/') return 64;
    sigset_t watched, empty, defaults;
    sigemptyset(&watched);
    sigaddset(&watched, SIGTERM);
    sigaddset(&watched, SIGINT);
    sigaddset(&watched, SIGHUP);
    sigaddset(&watched, SIGCHLD);
    if (sigprocmask(SIG_BLOCK, &watched, NULL) != 0) return 71;
    /* SIGCHLD must generate a waitable event, even if inherited as ignored. */
    struct sigaction action = {0};
    action.sa_handler = child_changed;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGCHLD, &action, NULL) != 0) return 71;
    sigemptyset(&empty);
    defaults = watched;
    posix_spawnattr_t attr;
    int error = posix_spawnattr_init(&attr);
    if (error) return 71;
    error = posix_spawnattr_setsigmask(&attr, &empty);
    if (!error) error = posix_spawnattr_setsigdefault(&attr, &defaults);
    if (!error) error = posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
    pid_t child;
    if (!error) error = posix_spawn(&child, argv[1], NULL, &attr, argv + 1, environ);
    posix_spawnattr_destroy(&attr);
    if (error) { errno = error; perror("StillOn Agent"); return 71; }
    for (;;) {
        int status;
        pid_t result = waitpid(child, &status, WNOHANG);
        if (result == child) {
            if (WIFEXITED(status)) return WEXITSTATUS(status);
            if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
        }
        if (result < 0 && errno != EINTR) return 71;
        int received;
        if (sigwait(&watched, &received) != 0) return 71;
        if (received != SIGCHLD) kill(child, received);
    }
}
