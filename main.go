package main

import (
	"encoding/json"
	"fmt"
	_ "log"
	"net/http"
	"strconv"
	"time"

	_ "modernc.org/sqlite"
)

const DATABASE_FILENAME = "crawler.db"
const rangeId = 1000
const startId = 1000

// geminola salvando
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

func getWiki(client *http.Client, id int, chann chan int) {
	url := fmt.Sprintf("https://pt.wikipedia.org/w/api.php?action=query&pageids=%d&prop=info|revisions&inprop=url&rvprop=content&rvslots=main&format=json&formatversion=2", id)
	req, _ := http.NewRequest("GET", url, nil)
	// headers pra não bloquear o bot
	req.Header.Set("User-agent", "wikiCrawlerBolado/6.7 (emailcontato@gmail.com)")
	//req.Header.Set("Accept-Encoding", "gzip")

	res, err := client.Do(req)
	if err != nil {
		fmt.Println("Error on req")
	}

	if res.StatusCode == 429 {
		waitTime, _ := strconv.Atoi(res.Header.Get("Retry-After"))
		chann <- waitTime
	} else if res.StatusCode != 200 {
		fmt.Printf("Invalid requisition: %d\n", res.StatusCode)
		chann <- -1
	}

	var body WikipediaRevisionResponse
	_ = json.NewDecoder(res.Body).Decode(&body)
	fmt.Printf("Page id: %d\tTitle: %s\n", id, body.Query.Pages[0].Title)
	res.Body.Close()
	chann <- 0
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

	//criando um 'setInterval'
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	wtChann := make(chan int)

	client := &http.Client{
		Timeout: 5 * time.Second,
	}

	pageId := startId
	for range ticker.C {
		go getWiki(client, pageId, wtChann)

		waitTime := <-wtChann
		if waitTime >= 0 {
			time.Sleep(time.Duration(waitTime) * time.Millisecond)
		}
		pageId++

		if pageId > startId+rangeId {
			ticker.Stop()
		}
	}

	/*
	   c := colly.NewCollector()

	   // Find and visit all links

	   	c.OnHTML("a[href]", func(e *colly.HTMLElement) {
	   		e.Request.Visit(e.Attr("href"))
	   	})

	   	c.OnRequest(func(r *colly.Request) {
	   		fmt.Println("Visiting", r.URL)
	   	})

	   c.Visit("http://go-colly.org/")
	*/
}
