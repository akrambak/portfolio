import "server-only";
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';


// Define the structure of your frontmatter
export interface PostFrontmatter {
  title: string;
  date: string; // Keep as string for serialization
  excerpt: string;
  category?: string;
  tags?: string[];
  [key: string]: string | string[] | undefined; // More specific type instead of any
}

export interface Post<TFrontmatter> {
  slug: string;
  frontmatter: TFrontmatter;
  /** Estimated reading time in whole minutes, at 200 wpm. */
  readingMinutes: number;
}

/** Word count / 200, floored at 1. Cheap and good enough for a badge. */
function estimateReadingMinutes(content: string): number {
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

export interface PostWithSource<TFrontmatter> extends Post<TFrontmatter> {
  /**
   * Raw MDX body.
   *
   * `MDXRemote` from `next-mdx-remote/rsc` compiles the source itself and
   * expects a string. Handing it the object returned by the client-side
   * `serialize()` renders nothing at all — which is what used to happen here.
   */
  source: string;
}

const postsDirectory = path.join(process.cwd(), 'content/blog');

/**
 * The shape `getAllPostSlugs()` actually produces: a bare filename, never a path.
 *
 * `/blog/[slug]` is not limited to the slugs `generateStaticParams` returned —
 * `dynamicParams` defaults to true, so any slug reaches `getPostData` and is
 * rendered on demand. Route params arrive percent-decoded, which means a request
 * for `%2e%2e%2f%2e%2e%2fetc%2fpasswd` hands this module `../../etc/passwd` and
 * `path.join` walks it straight out of content/blog.
 *
 * Matching the permitted shape rather than blacklisting `..` is what makes this
 * hold: with no separator, no dot and no NUL able to appear, there is no traversal
 * to encode around, and the joined path cannot leave the directory by construction.
 */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Get all filenames/slugs from the blog directory
export function getAllPostSlugs() {
  try {
    const fileNames = fs.readdirSync(postsDirectory);
    return fileNames
      .filter((fileName) => fileName.endsWith('.mdx'))
      .map((fileName) => fileName.replace(/\.mdx$/, ''));
  } catch (error) {
    console.error("Error reading blog directory:", error);
    return []; // Return empty array if directory doesn't exist or error occurs
  }
}

// Get sorted posts data (slug + frontmatter)
export function getSortedPostsData(): Post<PostFrontmatter>[] {
  const slugs = getAllPostSlugs();
  const allPostsData = slugs.map((slug) => {
    const fullPath = path.join(postsDirectory, `${slug}.mdx`);
    const fileContents = fs.readFileSync(fullPath, 'utf8');
    const { data, content } = matter(fileContents);

    // Ensure date is treated correctly
    const frontmatter = { ...data, date: data.date.toISOString() } as PostFrontmatter;

    return {
      slug,
      frontmatter,
      readingMinutes: estimateReadingMinutes(content),
    };
  });

  // Sort posts by date (newest first)
  return allPostsData.sort((a, b) => {
    const dateA = new Date(a.frontmatter.date);
    const dateB = new Date(b.frontmatter.date);
    return dateB.getTime() - dateA.getTime();
  });
}

// Get individual post data and serialize MDX
export async function getPostData(slug: string): Promise<PostWithSource<PostFrontmatter> | null> {
  // Refused before it can reach the filesystem. Returning null rather than throwing
  // keeps this on the existing "no such post" path, so the caller still 404s.
  if (!SLUG.test(slug)) return null;

  const fullPath = path.join(postsDirectory, `${slug}.mdx`);
  try {
    const fileContents = fs.readFileSync(fullPath, 'utf8');
    const { data, content } = matter(fileContents);

    // Convert date to string for serialization
    const frontmatter = { ...data, date: data.date.toISOString() } as PostFrontmatter;

    return {
      slug,
      frontmatter,
      source: content,
      readingMinutes: estimateReadingMinutes(content),
    };
  } catch (error) {
    console.error(`Error reading post ${slug}:`, error);
    return null; // Return null if file not found or error occurs
  }
} 