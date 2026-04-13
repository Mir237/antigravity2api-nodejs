package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"golang.org/x/net/http2"
	"golang.org/x/net/proxy"
)

type workerRequest struct {
	ID     string        `json:"id"`
	Method string        `json:"method"`
	Params requestParams `json:"params"`
}

type requestParams struct {
	URL          string            `json:"url"`
	Method       string            `json:"method"`
	Headers      map[string]string `json:"headers"`
	Body         string            `json:"body"`
	BodyEncoding string            `json:"bodyEncoding"`
	TimeoutMS    int               `json:"timeoutMs"`
	Proxy        string            `json:"proxy"`
}

type workerResponse struct {
	Type    string            `json:"type"`
	ID      string            `json:"id,omitempty"`
	Status  int               `json:"status,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
	Chunk   string            `json:"chunk,omitempty"`
	Message string            `json:"message,omitempty"`
}

type workerState struct {
	writer *bufio.Writer
	client *http.Client
}

func main() {
	state, err := newWorkerState()
	if err != nil {
		emit(workerResponse{Type: "error", Message: err.Error()})
		os.Exit(1)
	}

	state.send(workerResponse{Type: "ready"})

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var request workerRequest
		if err := json.Unmarshal([]byte(line), &request); err != nil {
			state.send(workerResponse{Type: "error", Message: fmt.Sprintf("invalid request: %v", err)})
			continue
		}
		go state.handle(request)
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "stdin scan failed: %v\n", err)
	}
}

func newWorkerState() (*workerState, error) {
	client, err := buildHTTPClient()
	if err != nil {
		return nil, err
	}
	return &workerState{
		writer: bufio.NewWriter(os.Stdout),
		client: client,
	}, nil
}

func buildHTTPClient() (*http.Client, error) {
	transport := &http.Transport{
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   20,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}

	if err := http2.ConfigureTransport(transport); err != nil {
		return nil, fmt.Errorf("configure http2 transport failed: %w", err)
	}

	return &http.Client{Transport: transport}, nil
}

func (w *workerState) handle(request workerRequest) {
	switch request.Method {
	case "request":
		w.handleRequest(request)
	case "stream":
		w.handleStream(request)
	default:
		w.send(workerResponse{Type: "error", ID: request.ID, Message: "unknown method"})
	}
}

func (w *workerState) handleRequest(request workerRequest) {
	response, err := w.perform(request.Params)
	if err != nil {
		w.send(workerResponse{Type: "error", ID: request.ID, Message: err.Error()})
		return
	}
	defer response.Body.Close()

	reader, err := wrapResponseBody(response)
	if err != nil {
		w.send(workerResponse{Type: "error", ID: request.ID, Message: err.Error()})
		return
	}
	defer reader.Close()

	body, err := io.ReadAll(reader)
	if err != nil {
		w.send(workerResponse{Type: "error", ID: request.ID, Message: err.Error()})
		return
	}

	w.send(workerResponse{
		Type:    "response",
		ID:      request.ID,
		Status:  response.StatusCode,
		Headers: flattenHeaders(response.Header),
		Body:    string(body),
	})
}

func (w *workerState) handleStream(request workerRequest) {
	response, err := w.perform(request.Params)
	if err != nil {
		w.send(workerResponse{Type: "error", ID: request.ID, Message: err.Error()})
		return
	}
	defer response.Body.Close()

	reader, err := wrapResponseBody(response)
	if err != nil {
		w.send(workerResponse{Type: "error", ID: request.ID, Message: err.Error()})
		return
	}
	defer reader.Close()

	w.send(workerResponse{
		Type:    "stream-start",
		ID:      request.ID,
		Status:  response.StatusCode,
		Headers: flattenHeaders(response.Header),
	})

	buffer := make([]byte, 4096)
	for {
		n, readErr := reader.Read(buffer)
		if n > 0 {
			w.send(workerResponse{
				Type:  "stream-data",
				ID:    request.ID,
				Chunk: string(buffer[:n]),
			})
		}
		if errors.Is(readErr, io.EOF) {
			w.send(workerResponse{Type: "stream-end", ID: request.ID})
			return
		}
		if readErr != nil {
			w.send(workerResponse{Type: "error", ID: request.ID, Message: readErr.Error()})
			return
		}
	}
}

func (w *workerState) perform(params requestParams) (*http.Response, error) {
	timeout := 300 * time.Second
	if params.TimeoutMS > 0 {
		timeout = time.Duration(params.TimeoutMS) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	client := w.client
	if strings.TrimSpace(params.Proxy) != "" {
		proxied, err := buildProxiedHTTPClient(strings.TrimSpace(params.Proxy))
		if err != nil {
			return nil, err
		}
		client = proxied
	}

	method := strings.TrimSpace(params.Method)
	if method == "" {
		method = http.MethodPost
	}

	requestBody, err := decodeRequestBody(params)
	if err != nil {
		return nil, err
	}

	request, err := http.NewRequestWithContext(ctx, method, params.URL, bytes.NewReader(requestBody))
	if err != nil {
		return nil, err
	}
	for key, value := range params.Headers {
		request.Header.Set(key, value)
	}

	return client.Do(request)
}

func decodeRequestBody(params requestParams) ([]byte, error) {
	if params.Body == "" {
		return nil, nil
	}
	if strings.EqualFold(strings.TrimSpace(params.BodyEncoding), "base64") {
		data, err := base64.StdEncoding.DecodeString(params.Body)
		if err != nil {
			return nil, fmt.Errorf("decode base64 body failed: %w", err)
		}
		return data, nil
	}
	return []byte(params.Body), nil
}

func buildProxiedHTTPClient(proxyURL string) (*http.Client, error) {
	transport := &http.Transport{
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   20,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}

	parsed, err := url.Parse(proxyURL)
	if err != nil {
		return nil, fmt.Errorf("invalid proxy url: %w", err)
	}

	switch parsed.Scheme {
	case "http", "https":
		transport.Proxy = http.ProxyURL(parsed)
	case "socks4", "socks5", "socks5h":
		baseDialer := &net.Dialer{Timeout: 30 * time.Second}
		dialer, err := proxy.FromURL(parsed, baseDialer)
		if err != nil {
			return nil, fmt.Errorf("invalid socks proxy: %w", err)
		}
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			type dialResult struct {
				conn net.Conn
				err  error
			}
			done := make(chan dialResult, 1)
			go func() {
				conn, err := dialer.Dial(network, address)
				done <- dialResult{conn: conn, err: err}
			}()
			select {
			case result := <-done:
				return result.conn, result.err
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
	default:
		return nil, fmt.Errorf("unsupported proxy scheme: %s", parsed.Scheme)
	}

	if err := http2.ConfigureTransport(transport); err != nil {
		return nil, fmt.Errorf("configure proxied http2 transport failed: %w", err)
	}
	return &http.Client{Transport: transport}, nil
}

func wrapResponseBody(response *http.Response) (io.ReadCloser, error) {
	if response == nil || response.Body == nil {
		return nil, errors.New("response body is empty")
	}
	if !strings.EqualFold(strings.TrimSpace(response.Header.Get("Content-Encoding")), "gzip") {
		return response.Body, nil
	}
	reader, err := gzip.NewReader(response.Body)
	if err != nil {
		return nil, err
	}
	return &combinedReadCloser{
		Reader: reader,
		closeFn: func() error {
			errOne := reader.Close()
			errTwo := response.Body.Close()
			if errOne != nil {
				return errOne
			}
			return errTwo
		},
	}, nil
}

type combinedReadCloser struct {
	io.Reader
	closeFn func() error
}

func (c *combinedReadCloser) Close() error {
	if c.closeFn == nil {
		return nil
	}
	return c.closeFn()
}

func flattenHeaders(header http.Header) map[string]string {
	result := make(map[string]string, len(header))
	for key, values := range header {
		result[strings.ToLower(key)] = strings.Join(values, ", ")
	}
	return result
}

func (w *workerState) send(message workerResponse) {
	bytes, err := json.Marshal(message)
	if err != nil {
		return
	}
	_, _ = w.writer.Write(append(bytes, '\n'))
	_ = w.writer.Flush()
}

func emit(message workerResponse) {
	bytes, _ := json.Marshal(message)
	_, _ = os.Stdout.Write(append(bytes, '\n'))
}
