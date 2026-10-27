import Foundation

@main
struct MatchingTests {
    static func main() {
        let source = "https://www.google.com/maps/search/?api=1&query=The+Revolutionary+Dining+Room+Hyatt+Regency+Sofia"
        let base = "https://www.google.com/maps/place/The+Revolutionary+Dining+Room+%26+Bar/@42.6964683,23.3356628,17z/data=!3m1!4b1!4m6!3m5!1s0x40aa8541e3d5da63:0x5353ef1753a6f43c!8m2!3d42.6964683!4d23.3356628!16s%2Fg%2F11kv7qxcs3?entry=ttu&g_ep=EgoyMDI2MTAyMC4wIKXMDSoASAFQAw%3D%3D"
        let deep = "https://www.google.com/maps/place/The+Revolutionary+Dining+Room+%26+Bar/@42.6964683,23.3356628,3a,88.5y,90t/data=!3m8!1e2!3m6!1sCIHM0ogKEICAgIC6zNWDHA!2e10!3e12!6shttps:%2F%2Flh3.googleusercontent.com%2Fgrass-cs%2FAABkmLc0wSTVDS2qldfNOcASbraWFSU_1cn4jPLny5D-FmJGYE0w5ipNuaxaEfnu6JgJE7VNNlFRcsj1H61-m1kQlpWGHiN6UBINK9tOi6KCKtt2xRScCj_BOFwDxAeFBCGRg8Z9Arnf%3Dw129-h86-k-no!7i1000!8i666!4m7!3m6!1s0x40aa8541e3d5da63:0x5353ef1753a6f43c!8m2!3d42.6964683!4d23.3356628!10e5!16s%2Fg%2F11kv7qxcs3?entry=ttu&g_ep=EgoyMDI2MTAyMC4wIKXMDSoASAFQAw%3D%3D"
        let other = deep.replacingOccurrences(of: "0x5353ef1753a6f43c", with: "0x5353ef1753a6f43d")
        precondition(mapsPlaceKey(base) == "google-maps-place:0x40aa8541e3d5da63:0x5353ef1753a6f43c")
        precondition(mapsPlaceKey(base) == mapsPlaceKey(deep))
        precondition(mapsPlaceKey(other) != mapsPlaceKey(base))
        precondition(matchingResourceURL(base, openURLs: [other, deep], relationships: [:]) == deep)
        precondition(matchingResourceURL(source, openURLs: [other, deep], relationships: [source: [base]]) == deep)
        precondition(matchingResourceURL(source, openURLs: [other], relationships: [source: [base]]) == nil)
        precondition(matchingResourceURL(source, openURLs: [deep], relationships: [:]) == nil)
        precondition(matchingResourceURL(base, openURLs: [deep, base], relationships: [:]) == base)
        precondition(matchingResourceURL(base, openURLs: [deep, base], relationships: [:], preferredURL: deep) == deep)
        precondition(matchingResourceURL(base, openURLs: [other, base], relationships: [:], preferredURL: other) == base)
        precondition(mapsPlaceKey(base.replacingOccurrences(of: "www.google.com", with: "www.google.com.evil.test")) == nil)
        precondition(mapsPlaceKey(base.replacingOccurrences(of: "/maps/place/", with: "/maps/dir/")) == nil)
        precondition(mapsPlaceKey(base.replacingOccurrences(of: "!4m6!3m5", with: "!4m6!9m5")) == nil)
        precondition(mapsPlaceKey(base.replacingOccurrences(of: "?entry", with: "!4m6!3m5!1s0xabc:0xdef?entry")) == nil)
        let product = "https://shop.test/products/42"
        let reviews = product + "/reviews"
        let photo = product + "/photos"
        let next = "https://shop.test/products/43/reviews"
        let links: [String: Set<String>] = [reviews: [product], photo: [product], "https://shop.test/short": [product]]
        precondition(matchingResourceURL(product, openURLs: [next, reviews], relationships: links) == reviews)
        precondition(matchingResourceURL(reviews, openURLs: [photo], relationships: links) == photo)
        precondition(matchingResourceURL("https://shop.test/short", openURLs: [reviews], relationships: links) == reviews)
        precondition(matchingResourceURL(product, openURLs: [reviews], relationships: [:]) == nil)
        precondition(matchingResourceURL(product, openURLs: [next], relationships: links) == nil)
        precondition(matchingResourceURL(product, openURLs: [product + "?id=43"], relationships: [:]) == nil)
        precondition(matchingResourceURL(product, openURLs: [product + "#other"], relationships: [:]) == nil)
        precondition(resourceKeys(product, relationships: [product: [reviews], reviews: [product]]).count == 2)
        precondition(matchingResourceURL(product, openURLs: [product, reviews], relationships: links, preferredURL: reviews) == reviews)
        print("24 resource matching checks passed, including the supplied Maps URLs")
    }
}
