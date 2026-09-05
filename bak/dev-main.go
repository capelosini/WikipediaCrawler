package main

import (
	"encoding/json"
	"fmt"
	_ "log"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/gocolly/colly/v2"
	_ "modernc.org/sqlite"
)

const DATABASE_FILENAME = "crawler.db"
const BASE_URL = "https://pt.wikipedia.org"
const START_POINT = "Flip-flop"
const rangeId = 1000
const startId = 1000

type Set[T comparable] map[T]struct{}

func (s Set[T]) Add(item T) {
	s[item] = struct{}{}
}

func (s Set[T]) ToSlice() []T {
	vector := make([]T, 0, len(s))
	for item := range s {
		vector = append(vector, item)
	}
	return vector
}

type WikipediaRevisionResponse struct {
	Query struct {
		Pages []struct {
			PageID    int
			Title     string
			Revisions []struct {
				Slots struct {
					Main struct {
						Content string
					}
				}
			}
		}
	}
}

type WikiSummary struct {
	Type        string
	Title       string
	PageID      int
	Extract     string
	ExtractHTML string
}

var namespaceRegex = regexp.MustCompile(`^[\p{L}\p{N}_-]+:`)

// validates a Wikipedia URL and returns only the article part.
func extractWikiArticle(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}

	if !strings.HasSuffix(u.Host, "wikipedia.org") {
		return ""
	}

	if !strings.HasPrefix(u.Path, "/wiki/") {
		return ""
	}

	decodedArticle := strings.TrimPrefix(u.Path, "/wiki/")
	rawArticle := strings.TrimPrefix(u.EscapedPath(), "/wiki/")

	if decodedArticle == "" {
		return ""
	}

	if namespaceRegex.MatchString(decodedArticle) {
		return ""
	}

	return rawArticle
}

func getWikiSummary(client *http.Client, wikiTitle string) WikiSummary {
	url := fmt.Sprintf("https://pt.wikipedia.org/api/rest_v1/page/summary/%s", wikiTitle)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-agent", "wikiCrawlerBolado/6.7 (emailcontato@gmail.com)")

	res, err := client.Do(req)
	if err != nil {
		fmt.Println("Error on req")
	}
	defer res.Body.Close()

	var body WikiSummary
	_ = json.NewDecoder(res.Body).Decode(&body)
	return body
}

func getWikis(client *http.Client, id string) WikipediaRevisionResponse {
	url := fmt.Sprintf("https://pt.wikipedia.org/w/api.php?action=query&titles=%s&prop=info|revisions&inprop=url&rvprop=content&rvslots=main&format=json&formatversion=2", id)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-agent", "wikiCrawlerBolado/6.7 (emailcontato@gmail.com)")

	res, err := client.Do(req)
	if err != nil {
		fmt.Println("Error on req")
	}
	defer res.Body.Close()

	// if res.StatusCode == 429 {
	// 	waitTime, _ := strconv.Atoi(res.Header.Get("Retry-After"))
	// } else if res.StatusCode != 200 {
	// 	fmt.Printf("Invalid request: %d\n", res.StatusCode)
	// }

	var body WikipediaRevisionResponse
	_ = json.NewDecoder(res.Body).Decode(&body)
	//fmt.Printf("Page id: %d\tTitle: %s\n", id, body.Query.Pages[0].Title)
	// chann <- 0
	return body
}

func main() {
	// iniciando db
	db, err := OpenDatabase(DATABASE_FILENAME)
	if err != nil {
		return
	}
	defer db.CloseDatabase()

	err = db.CreateTables()

	if err != nil {
		return
	}

	// client := &http.Client{}

	c := colly.NewCollector()

	// Find and visit all links

	//queue := make(chan string, 0) // Fila com capacidade de 10
	//queue <- "tarefa 1"           // Enfileirando (Enqueue)
	//item := <-queue               // Desenfileirando (Dequeue)

	wikis := make(Set[string])

	c.OnHTML("a[href]", func(e *colly.HTMLElement) {
		if e.Attr("rel") != "mw:WikiLink" || e.Attr("class") == "new" {
			return
		}
		wikiTitleId := extractWikiArticle(e.Attr("href"))
		if wikiTitleId == "" {
			return
		}
		fmt.Println(wikiTitleId)
		wikis.Add(wikiTitleId)
	})

	c.OnRequest(func(r *colly.Request) {
		fmt.Println("Visiting", r.URL)
		clear(wikis)
		fmt.Println("Clear the Set!")
	})

	c.OnScraped(func(r *colly.Response) {
		fmt.Println(strings.Join(wikis.ToSlice(), "|"))
	})

	c.Visit(fmt.Sprintf("%s/wiki/%s", BASE_URL, START_POINT))
}
