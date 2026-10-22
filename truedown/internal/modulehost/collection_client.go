package modulehost

import (
	"context"
	"fmt"
)

// ListCollection validates a complete, stable snapshot before the host admits
// any task. Both HTTP resolvers and artifact providers use the same bounds.
func ListCollection(ctx context.Context, client *Client, source, proxy string) (*ArtifactCollection, error) {
	collection := &ArtifactCollection{}
	total := -1
	for offset := 0; ; {
		var page CollectionPage
		if err := client.Call(ctx, "list", map[string]any{"source": source, "proxy": proxy, "offset": offset, "limit": 100}, &page); err != nil {
			return nil, err
		}
		if page.Total < 0 || page.Total > 6000 || len(page.Entries) > 100 || (total >= 0 && (page.Total != total || page.Name != collection.Name)) || offset+len(page.Entries) > page.Total {
			return nil, fmt.Errorf("invalid folder page")
		}
		if total < 0 {
			total, collection.Name = page.Total, page.Name
		}
		collection.Entries = append(collection.Entries, page.Entries...)
		if page.Next == -1 {
			if len(collection.Entries) != total {
				return nil, fmt.Errorf("incomplete folder listing")
			}
			break
		}
		if page.Next != offset+len(page.Entries) || page.Next <= offset {
			return nil, fmt.Errorf("invalid folder cursor")
		}
		offset = page.Next
	}
	if _, err := ValidateCollection(collection); err != nil {
		return nil, err
	}
	return collection, nil
}
