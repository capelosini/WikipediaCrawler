package main

import (
	"fmt"
	"io"
	"net/http"
	"time"
	"strconv"

	_ "modernc.org/sqlite"
)

const DATABASE_FILENAME = "crawler.db"
const rangeId = 1000
const startId = 1000

func getWiki(client *http.Client, id int) {
	url := fmt.Sprintf("https://pt.wikipedia.org/w/api.php?action=query&pageids=%d&prop=info|revisions&inprop=url&rvprop=content&rvslots=main&format=json&formatversion=2", id)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-agent", "emailcontato@gmail.com")
	req.Header.Set("Accept-Encoding", "gzip")

	res, err := client.Do(req)
	if err != nil {
		fmt.Println("Erro")
	}

	if res.StatusCode == 429 {
		waitTime := res.Header.Get("Retry-After")
		time.Sleep(strconv.ParseInt(waitTime, 10, 64) * time.Millisecond) // nao terminei
	}
	fmt.Printf("status: %d", res.StatusCode)

	body, _ := io.ReadAll(res.Body)
	fmt.Printf("%s", string(body))
	res.Body.Close()
}

func main() {
	db, err := OpenDatabase(DATABASE_FILENAME)
	if err != nil {
		return
	}
	defer db.CloseDatabase()

	err = db.CreateTables()

	if err != nil {
		return
	}

	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	pageId := startId

	client := &http.Client{
		Timeout: 5 * time.Second,
	}

	for range ticker.C {
		go getWiki(client, pageId)
		pageId++
	}

	if pageId > startId+rangeId {
		ticker.Stop()
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
