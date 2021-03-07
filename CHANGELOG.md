# 4.4.0

* Cache optimization
* Better resource handling
* Minimum posts and comments threshold
* Proxy configuration hints
* Alternative date interval check
* Apify SDK 1.0.2

# 4.1.0

* Added minimum post date to only get older posts
* Fixed reaction count for videos and photo posts
* Fixed likes parsing
* Skip pinned post if minimum date isn't set
* Added reactions breakdown (like, love, wow, sorry, haha, anger, support) for posts under `reactionsBreakdown`
* Updated SDK version

# 1.1.0

* Date input now allows relative time, such as `1 day`, `2 months`, `1 year`

# 1.0.0

* Changed fields on dataset (to allow `unwind` to work properly):
  * `url` -> `pageUrl`
  * `posts.text` -> `posts.postText`
  * `posts.date` -> `posts.postDate`
  * `posts.url` -> `posts.postUrl`
  * `posts.stats` -> `posts.postStats`
  * `posts.comments` -> `posts.postComments`
  * `posts.images` ->`posts.postImages`
  * `posts.links` -> `posts.postLinks`
* Dataset version set to 2

# 0.2.1

* Changes in scroll code and optimizations
