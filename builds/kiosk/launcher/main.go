// Kiosk launcher (SPEC §8.2).
//
// A sales engineer double-clicks one file and the demo opens in their default browser.
// That is the whole requirement, and it is why this exists at all: file:// breaks
// iframes and ES module loading, so the bundle needs a server — but a booth laptop
// cannot be assumed to have Node, npm or any network connection.
//
// So: one static binary, no dependencies, serves the directory it sits in, picks a free
// port, opens the browser, and refuses every request that is not a plain GET of a file
// inside the bundle.
//
// Build with builds/kiosk/launcher/build-launcher.mjs.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const banner = `
Pivot Path demo kiosk
---------------------
Serving %s
Open %s

Leave this window open while you present. Close it to stop the demo.
`

func main() {
	port := flag.Int("port", 0, "port to listen on (0 picks a free one)")
	noBrowser := flag.Bool("no-browser", false, "do not open the browser")
	dir := flag.String("dir", "", "directory to serve (defaults to the binary's own directory)")
	flag.Parse()

	root, err := resolveRoot(*dir)
	if err != nil {
		fatal(err)
	}

	if _, err := os.Stat(filepath.Join(root, "index.html")); err != nil {
		fatal(fmt.Errorf("no index.html in %s — is this a kiosk bundle?", root))
	}

	// 127.0.0.1 only. A tradeshow network is not somewhere to expose a server.
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		fatal(fmt.Errorf("could not open a local port: %w", err))
	}
	url := fmt.Sprintf("http://%s/", listener.Addr().String())

	fmt.Printf(banner, root, url)

	server := &http.Server{
		Handler:           handler(root),
		ReadHeaderTimeout: 10 * time.Second,
	}

	if !*noBrowser {
		go func() {
			// Give the listener a moment before the browser races it.
			time.Sleep(300 * time.Millisecond)
			if err := openBrowser(url); err != nil {
				fmt.Printf("Could not open a browser automatically. Open %s yourself.\n", url)
			}
		}()
	}

	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fatal(err)
	}
}

func resolveRoot(dir string) (string, error) {
	if dir != "" {
		return filepath.Abs(dir)
	}
	// The bundle sits next to the binary, which is how a double-click from a USB stick
	// ends up serving the right directory regardless of the working directory.
	executable, err := os.Executable()
	if err != nil {
		return os.Getwd()
	}
	resolved, err := filepath.EvalSymlinks(executable)
	if err != nil {
		resolved = executable
	}
	return filepath.Dir(resolved), nil
}

func handler(root string) http.Handler {
	fileSystem := http.Dir(root)
	fileServer := http.FileServer(fileSystem)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		clean := filepath.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
		if strings.Contains(clean, "..") {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		// The bundle is a static site: never cache, so replacing a demo folder on the
		// stick takes effect on the next reload rather than the next machine.
		w.Header().Set("Cache-Control", "no-store")
		// Belt and braces alongside the snapshot CSP and the player's iframe sandbox.
		w.Header().Set("X-Content-Type-Options", "nosniff")

		if clean == "/" {
			http.ServeFile(w, r, filepath.Join(root, "index.html"))
			return
		}

		if _, err := fs.Stat(os.DirFS(root), strings.TrimPrefix(clean, "/")); err != nil {
			// Single-page app fallback: the kiosk shell owns its own routing.
			http.ServeFile(w, r, filepath.Join(root, "index.html"))
			return
		}

		fileServer.ServeHTTP(w, r)
	})
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

func fatal(err error) {
	log.Printf("kiosk launcher: %v", err)
	fmt.Println("\nPress Enter to close this window.")
	_, _ = fmt.Scanln()
	os.Exit(1)
}
