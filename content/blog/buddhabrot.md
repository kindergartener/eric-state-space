+++
title = "Buddhabrot"
date = 2025-08-04
[taxonomies]
tags = ["rust", "math", "visualization", "creative-coding", "numerical-computation"]
+++

The Mandelbrot set is one of those pieces of math that somehow finds itself into the public consciousness, the quintessential example of a fractal.
Very informally, it's the set of complex numbers \\(c\\) for which the function \\(f(z) = z^2 + c\\) doesn't diverge when iterated to infinity.

Renders of the set show an infinitely complex boundary that appears recursive and extremely detailed. You may also be familiar with
"zooms" of the Mandelbrot set that showcase this recursive nature:

<style>
  .mandelbrots-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    justify-items: center
  }
  .mandelbrots-grid img {
    max-width: 100%;
    height: auto;
    align-self: center;
  }
  .mandelbrots-grid figcaption {
    grid-column: 1 / -1;
  }
</style>

<figure class="mandelbrots-grid">
  <img alt="Mandelbrot Set" src="https://upload.wikimedia.org/wikipedia/commons/thumb/2/21/Mandel_zoom_00_mandelbrot_set.jpg/1280px-Mandel_zoom_00_mandelbrot_set.jpg" />
  <img alt="Mandelbrot Zoom" src="https://upload.wikimedia.org/wikipedia/commons/b/b8/Self-Similarity-Zoom.gif" />

  <figcaption>
    Render of the Mandelbrot set and a zoom from the <a href="https://en.wikipedia.org/wiki/Mandelbrot_set">Wikipedia page</a>.
  </figcaption>
</figure>

In this post I attempt to render the Buddhabrot, a related fractal spawned from the points that _do_ diverge.

# Where's the Buddha?

In short, the Buddhabrot is a probability distribution over the paths of points that diverge in the Mandelbrot fractal.
In other words, we look at each point that escapes in the Mandelbrot fractal and track each point it passes through on its journey
to divergence. This essentially creates a heatmap of the most commonly-visited spots as points travel off to infinity. Here's what it looks like:

<figure>
  <img alt="Buddhabrot" src="/images/buddhabrot.png" />
</figure>
<figcaption>
</figcaption>

Wow! The image is still fractal in nature but with a ghostly, almost outer-space-like element to it. In this way we can really see the fractal's namesake -- the Buddha
sitting in meditation pose. 

Okay I'm actually lying to you. The picture above isn't the _real_ Buddhabrot. The real image is just black-and-white and can look completely different based on the parameters you chose.
I'll show you the rendering process involved in creating the final image.

# The Rendering Process

The logic behind rendering a Buddhabrot image is pretty simple. First we create 2D image buffer with dimensions
`WIDTH` \\(\times\\) `HEIGHT`. Each pixel \\((i, j)\\) for \\(i = 1, \ldots , m\\) and \\(j = 1, \ldots , n\\) corresponds to the complex number
\\(c = \frac{\mathrm{WIDTH}}{m} + \frac{\mathrm{HEIGHT}}{n} i\\).

Each pixel has an associated counter that starts at 0. We sample `SAMPLES` random points (in our case 16,000,000) and iterate them
through the Mandelbrot function \\(f(z) = z^2 + c\\). For points that escape within a certain number of `MAX_ITERATIONS`, increment the counters
of all pixels passed through during that process. Discard points that don't escape with this process.

In the end we have a histogram showing the likelihood that escaped points pass these given pixels. The final step is to color each pixel in the output image a certain
grayscale value based on the normalized range of all pixel counter values.

What we end up with is an image like so:

<style>
  .iterations-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
    justify-items: center;
  }
  .iterations-grid img {
    max-width: 100%;
    height: auto;
  }
  .iterations-grid figcaption {
    grid-column: 1 / -1;
  }
</style>

<figure class="iterations-grid">
  <img alt="Buddhabrot MAX_ITERATIONS=16" src="/images/buddhabrot_16.png" />
  <img alt="Buddhabrot MAX_ITERATIONS=64" src="/images/buddhabrot_64.png" />
  <img alt="Buddhabrot MAX_ITERATIONS=256" src="/images/buddhabrot_256.png" />
  <img alt="Buddhabrot MAX_ITERATIONS=4096" src="/images/buddhabrot_4096.png" />

  <figcaption>
    Buddhabrot renders with (from top-left to bottom-right) MAX_ITERATIONS=16, 64, 256, 4096.
  </figcaption>
</figure>

Great! But these images are still in black-and-white. In the following section, I borrow a technique from astronomy
to breathe life into these pictures.

# Pseudocolor

Pseudocolor techniques map intensity values to colors in grayscale images. If you're wondering why the first Buddhabrot image looks like some sort of nebula,
it's because the same technique is used in astronomy to map non-visible light wavelengths to visible ones (colors).

In our case, we can change the value of `MAX_ITERATIONS` and map each output image to a specific color. Then, we layer the images on top of each other with the correct blending mode to
produce the final colorized image:

<figure>
  <img alt="Buddhabrot Color Combinations" src="/images/buddhabrot_color-combos.png" />

  <figcaption>
    Map MAX_ITERATIONS=64 to blue, 256 to red, and 4096 to green. Then combine with lighten blending mode.
  </figcaption>
</figure>

Below are a few examples of zoomed-in pseudocolor Buddhabrots:

<style>
  .pseudocolor-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
    justify-items: center;
  }
  .pseudocolor-grid img {
    max-width: 100%;
    height: auto;
  }
</style>

<figure>
  <img alt="Buddhabrot Zoom @ -0.3 + 0.65i" src="/images/buddhabrot_-0.3x0.65.png">
  <figcaption>
    Pseudocolor Buddhabrot zoom centered at -0.3 + 0.65i
  </figcaption>

  <br>

  <img alt="Buddhabrot Zoom @ -1.25 + 0.0i" src="/images/buddhabrot_-1.25x0.png">
  <figcaption>
    Pseudocolor Buddhabrot zoom centered at -1.25 + 0.0i
  </figcaption>
</figure>

# Towards Nirvana

The goal of this experiment was to create some neat visualizations using Rust and learn a thing or two along the way. While I was able to significantly decrease
rendering times by parallelizing with [rayon](https://crates.io/crates/rayon), the computation remains solely on the CPU. Perhaps one day I'll revisit the Buddha on the GPU,
similar to [this project](https://benedikt-bitterli.me/buddhabrot/). Furthermore, I'd love to approach the rendering process through a <a href="http://www.steckles.com/buddha/">probabilistic lens</a> by leveraging the
Metropolis-Hastings Algorithm.
