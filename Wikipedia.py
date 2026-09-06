# this is an API wrapper
import requests
from bs4 import BeautifulSoup
import re
import time

class Wikipedia:
    def __init__(self, lang="pt"):
        lang=str(lang).strip().lower()
        self._fileName = __file__.split('/')[-1]
        self.base_url = f"https://{lang}.wikipedia.org/w/api.php"
        self.summary_base_url = f"https://{lang}.wikipedia.org/api/rest_v1/page/summary"
        self.index_base_url_dict = {
            "pt": "https://pt.wikipedia.org/wiki/Especial:Todas_as_p%C3%A1ginas",
            "en": "https://en.wikipedia.org/wiki/Special:AllPages"
        }

        if lang not in list(self.index_base_url_dict.keys()):
            print(f"[{self._fileName}] Warning, this language is not totally supported by this wrapper!")

        self.s = requests.Session()
        self.s.headers.update({"User-Agent": "wikiCrawlerBolado/6.7 (emailcontato@gmail.com)"})

    @staticmethod
    def _retry(f, timeout=1.0, repeat=1):
        if repeat == 0:
            raise Exception("Retry attempts exceeded!")
        time.sleep(timeout)
        try:
            return f()
        except:
            Wikipedia._retry(f, timeout, repeat-1)

    def getWiki(self, **kwargs):
        if not kwargs:
            raise Exception(f"[{self._fileName}] No args passed into getWiki()")
        url = f"{self.base_url}?{'&'.join([f'{k}={str(kwargs.get(k))}' for k in list(kwargs.keys())])}"

        r = Wikipedia._retry(lambda: self.s.get(url), timeout=0.5, repeat=2)

        json = None
        try:
            json = r.json()
        except:
            raise Exception(r.status_code, r.text)
        return json

    @staticmethod
    def getWikisRelated(wikiContent: str):
        res = re.findall(r"\[\[[A-Za-z0-9\sáàâãéêíïóôõöúüçñÁÀÂÃÉÈÊÍÏÓÔÕÖÚÜÇÑ\-]+(?:\|[A-Za-z0-9\sáàâãéêíïóôõöúüçñÁÀÂÃÉÈÊÍÏÓÔÕÖÚÜÇÑ\-]+)?\]\]", wikiContent)
        if not res:
            return None

        res = list(set(res))

        def _clearTitle(title):
            res = ""
            for l in title:
                if l == "|" or l == "]":
                    return res.strip()
                if l != "[":
                    res+=l
            return res.strip()

        res = [_clearTitle(s) for s in res]

        return res
